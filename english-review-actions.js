/*
 * QuickAdd 2.20+ user script for postgraduate English I review.
 * Add this file to one QuickAdd Macro as a User Script action.
 */

const PATHS = {
    root: "03 - 英语",
    sessions: "03 - 英语/02 - 真题复盘/复习记录",
    readings: "03 - 英语/02 - 真题复盘/阅读",
    sentences: "03 - 英语/02 - 真题复盘/长难句",
    writing: "03 - 英语/02 - 真题复盘/作文",
    anki: "03 - 英语/Anki",
    daily: "_Daily_Tasks"
};

const ACTIONS = [
    "记录复习会话",
    "创建阅读复盘",
    "创建作文复盘",
    "抓取长难句",
    "制作 Anki 问答卡",
    "完成阶段复习"
];

const ERROR_TYPES = [
    "无",
    "词义",
    "句法",
    "定位",
    "逻辑",
    "选项偷换",
    "主旨",
    "态度",
    "时间",
    "粗心"
];

const REVIEW_LABELS = {
    1: "次日遮住答案重做",
    3: "第 3 天重做错题",
    7: "第 7 天重做整篇",
    21: "第 21 天复核仍不稳的题"
};
const REVIEW_FILE_LOCKS_KEY = Symbol.for("english-one-quickadd.review-file-locks");

module.exports = async (params) => {
    const { app, quickAddApi, abort, obsidian } = params;
    const Notice = obsidian.Notice;

    try {
        const action = await quickAddApi.suggester(ACTIONS, ACTIONS, "英语一复习操作");
        if (!action) return abort("已取消");

        switch (action) {
            case "记录复习会话":
                await recordSession(app, quickAddApi, abort, Notice);
                break;
            case "创建阅读复盘":
                await createReadingReview(app, quickAddApi, abort, Notice);
                break;
            case "创建作文复盘":
                await createWritingReview(app, quickAddApi, abort, Notice);
                break;
            case "抓取长难句":
                await captureSentence(app, quickAddApi, abort, Notice);
                break;
            case "制作 Anki 问答卡":
                await createAnkiCard(app, quickAddApi, abort, Notice);
                break;
            case "完成阶段复习":
                await completeReview(app, quickAddApi, abort, Notice, obsidian);
                break;
            default:
                return abort("未知操作");
        }
    } catch (error) {
        if (error && error.name === "MacroAbortError") throw error;
        console.error("English review QuickAdd failed", error);
        new Notice(`英语复习脚本失败：${error.message || String(error)}`, 8000);
    }
};

async function recordSession(app, api, abort, Notice) {
    const values = await api.requestInputs([
        {
            id: "kind",
            label: "复习类型",
            type: "dropdown",
            options: ["词汇", "语法", "阅读", "长难句", "翻译", "完形", "新题型", "小作文", "大作文", "套卷复盘", "其他"]
        },
        {
            id: "minutes",
            label: "有效学习分钟",
            type: "number",
            numericConfig: { min: 1, max: 600, step: 1 }
        },
        {
            id: "amount",
            label: "数量（可空，如复习词数/篇数）",
            type: "number",
            optional: true,
            numericConfig: { min: 0, max: 5000, step: 1 }
        },
        {
            id: "source",
            label: "材料来源（可空）",
            type: "text",
            optional: true,
            placeholder: "例如：2012 Text-2 / 红宝书 Unit 5"
        },
        {
            id: "result",
            label: "结果（可空）",
            type: "text",
            optional: true,
            placeholder: "例如：4/5、二稿完成"
        }
    ]);

    if (!values.kind || !values.minutes) return abort("已取消");
    const minutes = requireNumber(values.minutes, 1, 600, "有效学习分钟");
    const amount = optionalNumber(values.amount, 0, 5000, "数量");
    const file = await createSessionFile(app, {
        kind: values.kind,
        minutes,
        amount,
        source: values.source,
        result: values.result
    });

    await appendDailyLogSafely(app, file, `${values.kind} ${minutes} 分钟`, Notice);
    await openFileSafely(app, file, Notice);
    new Notice(`已记录：${values.kind} ${minutes} 分钟`);
}

async function createReadingReview(app, api, abort, Notice) {
    const values = await api.requestInputs([
        {
            id: "year",
            label: "真题年份",
            type: "number",
            defaultValue: "2005",
            numericConfig: { min: 1997, max: 2026, step: 1 }
        },
        {
            id: "passage",
            label: "篇目",
            type: "dropdown",
            options: ["Text-1", "Text-2", "Text-3", "Text-4"]
        },
        {
            id: "correct",
            label: "首做正确题数",
            type: "number",
            numericConfig: { min: 0, max: 5, step: 1 }
        },
        {
            id: "minutes",
            label: "首做用时（分钟）",
            type: "number",
            numericConfig: { min: 1, max: 90, step: 1 }
        },
        {
            id: "error",
            label: "一个主错因",
            type: "dropdown",
            options: ERROR_TYPES
        },
        {
            id: "source",
            label: "资料名称（可空）",
            type: "text",
            optional: true,
            placeholder: "例如：英语一真题 PDF"
        }
    ]);

    if (!values.year || !values.passage || values.correct === "" || !values.minutes || !values.error) {
        return abort("已取消");
    }

    const year = requireNumber(values.year, 1997, 2026, "真题年份");
    const correct = requireNumber(values.correct, 0, 5, "正确题数");
    const minutes = requireNumber(values.minutes, 1, 90, "首做用时");
    const source = String(values.source || `${year} ${values.passage}`).trim();
    const captured = await getCaptureText(api);
    const evidence = await api.wideInputPrompt(
        "PDF++ 原文证据（可空）",
        "先在 PDF++ 复制 Quote；这里只放关键证据句，不粘整篇解析",
        captured
    );

    const today = localDate(0);
    const baseName = `${today}-${year}-${values.passage}`;
    const path = await uniqueMarkdownPath(app, PATHS.readings, baseName);
    const errorTags = values.error === "无" ? "[]" : `[${yamlString(values.error)}]`;
    const evidenceBlock = String(evidence || "").trim() || "> ";
    const content = `---
type: english-reading
date: ${today}
paper_year: ${year}
passage: ${yamlString(values.passage)}
section: ${yamlString("阅读A")}
correct: ${correct}
total: 5
minutes: ${minutes}
source: ${yamlString(source)}
error_tags: ${errorTags}
review_1: ${localDate(1)}
review_1_done: false
review_3: ${localDate(3)}
review_3_done: false
review_7: ${localDate(7)}
review_7_done: false
review_21: ${localDate(21)}
review_21_done: false
---

# ${year} ${values.passage} 阅读复盘

## 首做结果

- 得分：${correct} / 5
- 用时：${minutes} 分钟
- 主错因：${values.error}
- 不确定题：

## 文章结构

| 段落 | 一句话功能 |
|---|---|
| P1 |  |
| P2 |  |
| P3 |  |
| P4 |  |

## PDF++ 原文证据

${evidenceBlock}

## 错题证据链

| 题号 | 我的答案 -> 正确答案 | 原文证据 | 干扰项机制 | 下次动作 |
|---|---|---|---|---|
|  |  |  |  |  |

## 最多 3 个卡句

- 原句：
- 主干：
- 修饰与从句：
- 我的译文：

## 复习任务

- [ ] ${REVIEW_LABELS[1]} ⏫ 📅 ${localDate(1)}
- [ ] ${REVIEW_LABELS[3]} 📅 ${localDate(3)}
- [ ] ${REVIEW_LABELS[7]} 📅 ${localDate(7)}
- [ ] ${REVIEW_LABELS[21]} 📅 ${localDate(21)}

## 一条可迁移规则

遇到同类题，下次先：
`;

    const reviewFile = await app.vault.create(path, content);

    try {
        const sessionFile = await createSessionFile(app, {
            kind: "阅读",
            minutes,
            amount: 1,
            source: `${year} ${values.passage}`,
            result: `${correct}/5`,
            related: reviewFile.path
        });
        await appendDailyLogSafely(app, sessionFile, `阅读 ${year} ${values.passage}，${correct}/5`, Notice);
    } catch (sessionError) {
        console.error("Reading review was created, but its session log failed", sessionError);
        new Notice("阅读复盘已创建，但学习时长记录失败；可稍后手动补记。", 7000);
    }

    await openFileSafely(app, reviewFile, Notice);
    new Notice(`已创建 ${year} ${values.passage} 复盘，并安排 1/3/7/21 天回看`);
}

async function createWritingReview(app, api, abort, Notice) {
    const values = await api.requestInputs([
        {
            id: "genre",
            label: "作文类型",
            type: "dropdown",
            options: ["小作文", "大作文"]
        },
        {
            id: "topic",
            label: "题目关键词",
            type: "text",
            placeholder: "例如：2018 建议信 / 2020 图画作文"
        },
        {
            id: "minutes",
            label: "限时初稿用时（分钟）",
            type: "number",
            numericConfig: { min: 1, max: 90, step: 1 }
        },
        {
            id: "source",
            label: "题目来源（可空）",
            type: "text",
            optional: true,
            placeholder: "例如：2018 英语一"
        }
    ]);

    if (!values.genre || !String(values.topic || "").trim() || !values.minutes) return abort("已取消");

    const minutes = requireNumber(values.minutes, 1, 90, "限时初稿用时");
    const topic = String(values.topic).trim();
    const source = String(values.source || "").trim();
    const prompt = await api.wideInputPrompt(
        "作文题目与任务点（可空）",
        "粘贴题干，或只写必须覆盖的任务点",
        await getCaptureText(api)
    );
    const today = localDate(0);
    const rewriteDue = localDate(1);
    const path = await uniqueMarkdownPath(app, PATHS.writing, `${today}-${values.genre}-${topic}`);
    const content = `---
type: english-writing
date: ${today}
genre: ${yamlString(values.genre)}
topic: ${yamlString(topic)}
source: ${yamlString(source)}
minutes: ${minutes}
rewrite_due: ${rewriteDue}
rewrite_done: false
---

# ${values.genre}｜${topic}

## 题目与任务点

${String(prompt || "").trim()}

## 限时初稿


## 只改三类问题

| 原句 | 内容/结构/语法/搭配 | 二稿表达 |
|---|---|---|
|  |  |  |

## 二稿（必须自己重写）


## 二稿任务

- [ ] 完成自改二稿 📅 ${rewriteDue}

## 值得制卡的功能句（最多 3 句）

只列候选句；确认有复用价值后，再用 QuickAdd 的“制作 Anki 问答卡”。
`;

    const writingFile = await app.vault.create(path, content);
    try {
        const sessionFile = await createSessionFile(app, {
            kind: values.genre,
            minutes,
            amount: 1,
            source: source || topic,
            result: "限时初稿完成",
            related: writingFile.path
        });
        await appendDailyLogSafely(app, sessionFile, `${values.genre} ${minutes} 分钟`, Notice);
    } catch (sessionError) {
        console.error("Writing review was created, but its session log failed", sessionError);
        new Notice("作文复盘已创建，但学习时长记录失败；可稍后手动补记。", 7000);
    }

    await openFileSafely(app, writingFile, Notice);
    new Notice(`已创建${values.genre}复盘；二稿截止 ${rewriteDue}`);
}

async function captureSentence(app, api, abort, Notice) {
    const captured = await getCaptureText(api);
    const sentence = await api.wideInputPrompt(
        "原句或 PDF++ Quote",
        "先在 PDF 中选中句子并复制 Quote；也可以直接粘贴",
        captured
    );
    if (!String(sentence || "").trim()) return abort("没有可保存的句子");

    const values = await api.requestInputs([
        {
            id: "source",
            label: "来源（可空）",
            type: "text",
            optional: true,
            placeholder: "例如：2011 Text-3 P2"
        },
        {
            id: "grammar",
            label: "主要语法卡点",
            type: "dropdown",
            options: ["主干", "并列", "定语从句", "名词性从句", "状语从句", "非谓语", "比较结构", "插入/倒装", "代词指代", "其他"]
        },
        {
            id: "minutes",
            label: "拆句分钟（可空）",
            type: "number",
            optional: true,
            numericConfig: { min: 1, max: 120, step: 1 }
        }
    ]);

    if (!values.grammar) return abort("已取消");
    const minutes = optionalNumber(values.minutes, 1, 120, "拆句分钟");
    const today = localDate(0);
    const source = String(values.source || "").trim();
    const path = await uniqueMarkdownPath(
        app,
        PATHS.sentences,
        `${today}-${localTime("HHmm")}-${source || "长难句"}`
    );
    const content = `---
type: english-sentence
date: ${today}
source: ${yamlString(source)}
grammar_tags: [${yamlString(values.grammar)}]
review_1: ${localDate(1)}
review_1_done: false
anki_ready: false
---

# 长难句｜${source || today}

## 原句与出处

${String(sentence).trim()}

## 四步拆句

1. 谓语动词：
2. 主干：
3. 从句边界与连接词：
4. 非谓语、介词短语和插入语修饰谁：

## 自己的译文


## 暴露的规则


## 复习任务

- [ ] 24 小时后遮住原文重译 📅 ${localDate(1)}
`;

    const file = await app.vault.create(path, content);
    if (minutes != null) {
        try {
            const sessionFile = await createSessionFile(app, {
                kind: "长难句",
                minutes,
                amount: 1,
                source,
                related: file.path
            });
            await appendDailyLogSafely(app, sessionFile, `长难句 ${minutes} 分钟`, Notice);
        } catch (sessionError) {
            console.error("Sentence note was created, but its session log failed", sessionError);
            new Notice("长难句已保存，但学习时长记录失败；可稍后手动补记。", 7000);
        }
    }
    await openFileSafely(app, file, Notice);
    new Notice("长难句已保存；说明区不含 Q:/A:，不会被误扫成 Anki 卡");
}

async function createAnkiCard(app, api, abort, Notice) {
    const captured = await getCaptureText(api);
    const values = await api.requestInputs([
        {
            id: "kind",
            label: "卡片类型",
            type: "dropdown",
            options: ["熟词僻义", "易混词", "固定搭配", "长难句", "作文功能句"]
        },
        {
            id: "front",
            label: "正面问题",
            type: "text",
            defaultValue: firstUsefulLine(captured),
            placeholder: "只问一个知识点"
        },
        {
            id: "back",
            label: "背面答案",
            type: "text",
            placeholder: "直接答案 + 必要限制；不要写成长篇词典"
        }
    ]);

    if (!values.kind || !String(values.front || "").trim() || !String(values.back || "").trim()) {
        return abort("卡片内容不完整");
    }

    const front = asAnkiLine(values.front);
    const back = asAnkiLine(values.back);
    await ensureFolder(app, PATHS.anki);

    const duplicate = await findDuplicateCard(app, front);
    if (duplicate) {
        let keep;
        try {
            keep = await api.yesNoPrompt(
                "发现可能重复的卡片",
                `已存在于 ${duplicate.path}。仍然添加吗？`
            );
        } catch (_) {
            return abort("已取消重复卡");
        }
        if (!keep) return abort("已取消重复卡");
    }

    const dailyPath = `${PATHS.anki}/${localDate(0)}.md`;
    const card = `Q: ${front}\nA: ${back}\n\n`;
    let file = app.vault.getAbstractFileByPath(dailyPath);
    if (file && file.extension !== "md") throw new Error(`${dailyPath} 不是 Markdown 文件`);

    if (!file) {
        file = await app.vault.create(dailyPath, `TARGET DECK: 英语\n\n${card}`);
    } else {
        await app.vault.process(file, (content) => {
            const withDeck = /^TARGET DECK:/m.test(content) ? content : `TARGET DECK: 英语\n\n${content}`;
            return `${withDeck.trimEnd()}\n\n${card}`;
        });
    }

    await openFileSafely(app, file, Notice);
    new Notice(`已添加${values.kind}卡；请在 Anki 打开后执行 Obsidian_to_Anki: Scan Vault`);
}

async function completeReview(app, api, abort, Notice, obsidian) {
    const file = app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return abort("请先打开一篇阅读复盘笔记");

    return withFileLock(app, file.path, () => completeReviewFile(app, file, api, abort, Notice, obsidian));
}

async function completeReviewFile(app, file, api, abort, Notice, obsidian) {
    const frontmatter = await readFreshFrontmatter(app, file, obsidian);
    if (frontmatter.type === "english-writing") {
        await completeWritingRewrite(app, file, frontmatter, abort, Notice);
        return;
    }
    if (frontmatter.type !== "english-reading") return abort("当前文件不是英语阅读或作文复盘");

    const configuredStages = [1, 3, 7, 21].filter((item) => (
        frontmatter[`review_${item}`] != null || frontmatter[`review_${item}_done`] !== undefined
    ));
    if (configuredStages.length === 0) return abort("这篇阅读缺少复习阶段字段");
    const stage = configuredStages.find((item) => frontmatter[`review_${item}_done`] !== true);
    if (!stage) return abort("这篇阅读的全部复习阶段均已完成");
    const due = dateValue(frontmatter[`review_${stage}`]);
    if (!due) return abort(`第 ${stage} 天复习缺少有效日期`);
    if (due > localDate(0)) return abort(`下一轮复习在 ${due} 到期，今天不提前完成`);

    const result = await api.suggester(
        ["通过：能独立定位证据并做对", "不稳：明天再来一次"],
        ["pass", "retry"],
        "本次复习结果"
    );
    if (!result) return abort("已取消");

    const today = localDate(0);
    let changes;
    let transformTask;
    let historyResult;
    if (result === "pass") {
        changes = {
            [`review_${stage}_done`]: true,
            last_reviewed: today
        };
        transformTask = (content) => markReviewTaskDone(content, stage, due, today);
        historyResult = "通过";
    } else {
        const tomorrow = localDate(1);
        changes = {
            [`review_${stage}`]: tomorrow,
            [`review_${stage}_done`]: false,
            last_reviewed: today
        };
        transformTask = (content) => rescheduleReviewTask(content, stage, due, tomorrow);
        historyResult = "不稳，顺延 1 天";
    }

    await updateFrontmatterAndTask(app, file, frontmatter, changes, transformTask, (content) => (
        appendReviewHistory(content, { date: today, stage, result: historyResult })
    ), `未找到与 YAML 日期 ${due} 一致的第 ${stage} 天复习任务；YAML 未更新。请恢复脚本生成的任务文字与日期格式后重试`);
    new Notice(result === "pass" ? `已完成第 ${stage} 天复习` : "已顺延到明天；不要勾选为掌握");
}

async function completeWritingRewrite(app, file, frontmatter, abort, Notice) {
    if (frontmatter.rewrite_done === true) return abort("这篇作文的二稿已完成");
    const rewriteDue = dateValue(frontmatter.rewrite_due);
    if (!rewriteDue) return abort("这篇作文的二稿任务缺少有效日期");
    const today = localDate(0);
    await updateFrontmatterAndTask(app, file, frontmatter, {
        rewrite_done: true,
        last_reviewed: today
    }, (content) => markWritingTaskDone(content, rewriteDue, today), (content) => content,
    "未找到与 YAML 日期一致的作文二稿任务；YAML 未更新。请恢复脚本生成的任务文字与日期格式后重试");
    new Notice("已完成作文二稿");
}

async function createSessionFile(app, data) {
    const today = localDate(0);
    const time = localTime("HH:mm");
    const baseName = `${today}-${localTime("HHmmss")}-${data.kind}`;
    const path = await uniqueMarkdownPath(app, PATHS.sessions, baseName);
    const amount = data.amount == null ? 0 : data.amount;
    const amountDisplay = data.amount == null ? "-" : data.amount;
    const relatedLine = data.related ? `related: ${yamlString(data.related)}\n` : "";
    const content = `---
type: english-session
date: ${today}
time: ${yamlString(time)}
kind: ${yamlString(data.kind)}
minutes: ${data.minutes}
amount: ${amount}
source: ${yamlString(data.source || "")}
result: ${yamlString(data.result || "")}
${relatedLine}---

# ${data.kind}｜${today} ${time}

- 有效学习：${data.minutes} 分钟
- 数量：${amountDisplay}
- 来源：${data.source || "-"}
- 结果：${data.result || "-"}
${data.related ? `- 关联：[[${data.related}]]` : ""}

## 本次暴露


## 下次只改一个动作

`;
    return app.vault.create(path, content);
}

async function appendDailyLog(app, sessionFile, label) {
    const dailyPath = `${PATHS.daily}/${localDate(0)}.md`;
    const dailyFile = app.vault.getAbstractFileByPath(dailyPath);
    if (!dailyFile || dailyFile.extension !== "md") return;

    const marker = `<!-- english-session:${sessionFile.path} -->`;
    await app.vault.process(dailyFile, (content) => {
        if (content.includes(marker)) return content;
        const heading = "## 英语记录";
        const entry = `- [[${sessionFile.path}|${label}]] ${marker}`;
        return appendLineToSection(content, heading, entry);
    });
}

async function appendDailyLogSafely(app, sessionFile, label, Notice) {
    try {
        await appendDailyLog(app, sessionFile, label);
        return true;
    } catch (error) {
        console.error("English session was created, but its daily backlink failed", error);
        new Notice("学习时长已记录，但当日日记回链失败；不要重复补记时长。", 7000);
        return false;
    }
}

async function withFileLock(app, key, callback) {
    let locks = app[REVIEW_FILE_LOCKS_KEY];
    if (!locks) {
        locks = new Map();
        Object.defineProperty(app, REVIEW_FILE_LOCKS_KEY, {
            value: locks,
            configurable: true
        });
    }

    const previous = locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
        release = resolve;
    });
    locks.set(key, current);

    await previous.catch(() => {});
    try {
        return await callback();
    } finally {
        release();
        if (locks.get(key) === current) locks.delete(key);
    }
}

async function readFreshFrontmatter(app, file, obsidian) {
    if (obsidian && typeof obsidian.parseYaml === "function") {
        const read = typeof app.vault.read === "function"
            ? app.vault.read.bind(app.vault)
            : app.vault.cachedRead.bind(app.vault);
        const content = await read(file);
        const match = String(content).match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
        if (!match) return {};
        const parsed = obsidian.parseYaml(match[1]);
        return parsed && typeof parsed === "object" ? parsed : {};
    }

    const cache = app.metadataCache.getFileCache(file);
    return cache && cache.frontmatter ? cache.frontmatter : {};
}

async function updateFrontmatterAndTask(
    app,
    file,
    frontmatter,
    changes,
    transformTask,
    finalizeBody,
    missingTaskMessage
) {
    const original = await app.vault.cachedRead(file);
    if (!transformTask(original).matched) throw new Error(missingTaskMessage);

    const previous = new Map(Object.keys(changes).map((key) => [key, {
        exists: Object.prototype.hasOwnProperty.call(frontmatter, key),
        value: frontmatter[key]
    }]));
    let frontmatterUpdated = false;

    try {
        await app.fileManager.processFrontMatter(file, (fm) => {
            Object.assign(fm, changes);
        });
        frontmatterUpdated = true;

        let taskMatched = false;
        await app.vault.process(file, (content) => {
            const result = transformTask(content);
            taskMatched = result.matched;
            return taskMatched ? finalizeBody(result.content) : content;
        });
        if (!taskMatched) throw new Error(`${missingTaskMessage}（文件在处理时发生了变化）`);
    } catch (error) {
        if (frontmatterUpdated) {
            try {
                await app.fileManager.processFrontMatter(file, (fm) => {
                    previous.forEach((entry, key) => {
                        if (entry.exists) fm[key] = entry.value;
                        else delete fm[key];
                    });
                });
            } catch (rollbackError) {
                console.error("Failed to roll back English review frontmatter", rollbackError);
                const primary = error && error.message ? error.message : String(error);
                const rollback = rollbackError && rollbackError.message
                    ? rollbackError.message
                    : String(rollbackError);
                throw new Error(`${primary}；YAML 回滚失败，请立即核对当前笔记（${rollback}）`);
            }
        }
        throw error;
    }
}

async function getCaptureText(api) {
    const utility = api.utility || {};
    const selectionGetter = typeof utility.getSelection === "function"
        ? "getSelection"
        : typeof utility.getSelectedText === "function"
            ? "getSelectedText"
            : null;
    if (selectionGetter) {
        try {
            const value = await Promise.resolve(utility[selectionGetter]());
            if (String(value || "").trim()) return String(value).trim();
        } catch (error) {
            console.debug(`QuickAdd ${selectionGetter} unavailable`, error);
        }
    }

    try {
        if (typeof utility.getClipboard === "function") {
            const value = await Promise.resolve(utility.getClipboard());
            return String(value || "").trim();
        }
    } catch (error) {
        console.debug("QuickAdd clipboard unavailable", error);
    }
    return "";
}

async function ensureFolder(app, folderPath) {
    const parts = normalizePath(folderPath).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        const existing = app.vault.getAbstractFileByPath(current);
        if (!existing) await app.vault.createFolder(current);
        else if (!existing.children) throw new Error(`${current} 已存在但不是文件夹`);
    }
}

async function uniqueMarkdownPath(app, folder, rawName) {
    const normalizedFolder = normalizePath(folder);
    await ensureFolder(app, normalizedFolder);
    const base = sanitizeFileName(rawName) || "未命名";
    const prefix = normalizedFolder ? `${normalizedFolder}/` : "";
    let path = `${prefix}${base}.md`;
    let index = 2;
    while (app.vault.getAbstractFileByPath(path)) {
        path = `${prefix}${base}-${index}.md`;
        index += 1;
    }
    return path;
}

async function openFile(app, file) {
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file);
}

async function openFileSafely(app, file, Notice) {
    try {
        await openFile(app, file);
        return true;
    } catch (error) {
        console.error("Content was saved, but opening the file failed", error);
        new Notice("内容已经保存，但自动打开失败；请勿重复运行本次操作，可手动打开该文件。", 7000);
        return false;
    }
}

async function findDuplicateCard(app, front) {
    const expected = front.trim().toLocaleLowerCase();
    const ankiPath = normalizePath(PATHS.anki);
    const folder = app.vault.getAbstractFileByPath(ankiPath);
    const files = folder && Array.isArray(folder.children) && folder.children.length
        ? markdownFilesInFolder(folder)
        : app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${ankiPath}/`));

    const batchSize = 8;
    for (let index = 0; index < files.length; index += batchSize) {
        const batch = files.slice(index, index + batchSize);
        const contents = await Promise.all(batch.map((file) => app.vault.cachedRead(file)));
        const matchIndex = contents.findIndex((content) => {
            const questions = content.match(/^Q:\s*(.+)$/gm) || [];
            return questions.some((line) => line.slice(2).trim().toLocaleLowerCase() === expected);
        });
        if (matchIndex !== -1) return batch[matchIndex];
    }
    return null;
}

function markdownFilesInFolder(folder) {
    const files = [];
    const visit = (item) => {
        if (Array.isArray(item.children)) item.children.forEach(visit);
        else if (item.extension === "md") files.push(item);
    };
    folder.children.forEach(visit);
    return files;
}

function markReviewTaskDone(content, stage, expectedDue, date) {
    const label = escapeRegExp(REVIEW_LABELS[stage]);
    const pattern = new RegExp(
        `^- \\[[ xX]\\] (${label}[^\\n]*?📅 ${escapeRegExp(expectedDue)})(?: ✅ \\d{4}-\\d{2}-\\d{2})?[ \\t]*\\r?$`,
        "gm"
    );
    return replaceUniqueTaskInSection(content, "## 复习任务", pattern,
        (_, task) => `- [x] ${task} ✅ ${date}`);
}

function rescheduleReviewTask(content, stage, expectedDue, date) {
    const label = escapeRegExp(REVIEW_LABELS[stage]);
    const pattern = new RegExp(
        `^- \\[[ xX]\\] (${label}[^\\n]*?📅 )${escapeRegExp(expectedDue)}(?: ✅ \\d{4}-\\d{2}-\\d{2})?[ \\t]*\\r?$`,
        "gm"
    );
    return replaceUniqueTaskInSection(content, "## 复习任务", pattern,
        (_, task) => `- [ ] ${task}${date}`);
}

function markWritingTaskDone(content, expectedDue, date) {
    const pattern = new RegExp(
        `^- \\[[ xX]\\] (完成自改二稿[^\\n]*?📅 ${escapeRegExp(expectedDue)})(?: ✅ \\d{4}-\\d{2}-\\d{2})?[ \\t]*\\r?$`,
        "gm"
    );
    return replaceUniqueTaskInSection(content, "## 二稿任务", pattern,
        (_, task) => `- [x] ${task} ✅ ${date}`);
}

function replaceUniqueTaskInSection(content, heading, pattern, replacement) {
    const section = findSection(content, heading);
    if (!section) return { content, matched: false };

    const body = content.slice(section.bodyStart, section.end);
    let matches = 0;
    const updatedBody = body.replace(pattern, (...args) => {
        matches += 1;
        return replacement(...args);
    });
    if (matches !== 1) return { content, matched: false };
    return {
        content: `${content.slice(0, section.bodyStart)}${updatedBody}${content.slice(section.end)}`,
        matched: true
    };
}

function appendReviewHistory(content, row) {
    const heading = "## 复习记录";
    const table = "| 日期 | 阶段 | 结果 |\n|---|---:|---|";
    const line = `| ${row.date} | ${row.stage} 天 | ${row.result} |`;
    const section = findSection(content, heading);
    if (!section) return `${content.trimEnd()}\n\n${heading}\n\n${table}\n${line}\n`;

    const body = content.slice(section.bodyStart, section.end);
    const lines = body.split(/\r?\n/);
    const headerIndex = lines.findIndex((item) => item.trim() === "| 日期 | 阶段 | 结果 |");
    if (headerIndex === -1) {
        const existing = body.trim();
        const replacement = `\n\n${table}\n${line}${existing ? `\n\n${existing}` : ""}\n`;
        return `${content.slice(0, section.bodyStart)}${replacement}${content.slice(section.end)}`;
    }

    let insertIndex = headerIndex + 1;
    while (insertIndex < lines.length && /^\s*\|.*\|\s*$/.test(lines[insertIndex])) insertIndex += 1;
    lines.splice(insertIndex, 0, line);
    return `${content.slice(0, section.bodyStart)}${lines.join("\n")}${content.slice(section.end)}`;
}

function appendLineToSection(content, heading, line) {
    const section = findSection(content, heading);
    if (!section) return `${content.trimEnd()}\n\n${heading}\n\n${line}\n`;

    const before = content.slice(0, section.end).trimEnd();
    const after = content.slice(section.end).trimStart();
    return after ? `${before}\n${line}\n\n${after}\n` : `${before}\n${line}\n`;
}

function findSection(content, heading) {
    const pattern = new RegExp(`^${escapeRegExp(heading)}[ \\t]*$`, "m");
    const match = pattern.exec(content);
    if (!match) return null;
    const bodyStart = match.index + match[0].length;
    const rest = content.slice(bodyStart);
    const nextHeading = /^#{1,2}\s+/m.exec(rest);
    return {
        bodyStart,
        end: nextHeading ? bodyStart + nextHeading.index : content.length
    };
}

function requireNumber(value, min, max, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new Error(`${label}必须在 ${min}-${max} 之间`);
    }
    return number;
}

function optionalNumber(value, min, max, label) {
    if (value == null || String(value).trim() === "") return null;
    return requireNumber(value, min, max, label);
}

function localDate(offsetDays) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offsetDays);
    return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
}

function localTime(format) {
    const date = new Date();
    const values = {
        HH: pad(date.getHours()),
        mm: pad(date.getMinutes()),
        ss: pad(date.getSeconds())
    };
    return format.replace(/HH|mm|ss/g, (token) => values[token]);
}

function dateValue(value) {
    if (value && typeof value.toISODate === "function") return validIsoDate(value.toISODate());
    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return [value.getFullYear(), pad(value.getMonth() + 1), pad(value.getDate())].join("-");
    }
    const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
    return match ? validIsoDate(match[0]) : null;
}

function validIsoDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day
        ? match[0]
        : null;
}

function pad(value) {
    return String(value).padStart(2, "0");
}

function yamlString(value) {
    return JSON.stringify(String(value == null ? "" : value));
}

function sanitizeFileName(value) {
    return String(value || "")
        .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/[. ]+$/g, "")
        .trim()
        .slice(0, 100);
}

function normalizePath(value) {
    return String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function firstUsefulLine(value) {
    const line = String(value || "")
        .split(/\r?\n/)
        .map((item) => item.replace(/^>\s*/, "").trim())
        .find((item) => item && !item.startsWith("[[") && !item.startsWith("("));
    return String(line || "").slice(0, 160);
}

function asAnkiLine(value) {
    return String(value || "").replace(/\r?\n+/g, "<br>").trim();
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
