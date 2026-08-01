const assert = require("node:assert/strict");
const path = require("node:path");
const SCRIPT_PATH = path.resolve(process.env.QUICKADD_SCRIPT || path.join(__dirname, "english-review-actions.js"));
const run = require(SCRIPT_PATH);

function loadFreshRun() {
    delete require.cache[require.resolve(SCRIPT_PATH)];
    return require(SCRIPT_PATH);
}

class MockNotice {
    constructor(message) {
        MockNotice.messages.push(message);
    }
}
MockNotice.messages = [];

function createApp(initialFiles = {}) {
    const files = new Map();
    const folders = new Set();
    let activeFile = null;

    for (const [path, content] of Object.entries(initialFiles)) {
        const file = { path, extension: "md", name: path.split("/").at(-1) };
        files.set(path, { file, content });
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index += 1) {
            folders.add(parts.slice(0, index).join("/"));
        }
    }

    const app = {
        vault: {
            getAbstractFileByPath(path) {
                if (files.has(path)) return files.get(path).file;
                if (folders.has(path)) return { path, children: [] };
                return null;
            },
            async createFolder(path) {
                folders.add(path);
                return { path, children: [] };
            },
            async create(path, content) {
                assert.equal(files.has(path), false, `duplicate create: ${path}`);
                const file = { path, extension: "md", name: path.split("/").at(-1) };
                files.set(path, { file, content });
                return file;
            },
            async process(file, callback) {
                const record = files.get(file.path);
                record.content = callback(record.content);
            },
            async cachedRead(file) {
                return files.get(file.path).content;
            },
            getMarkdownFiles() {
                return [...files.values()].map((entry) => entry.file);
            }
        },
        workspace: {
            getActiveFile() {
                return activeFile;
            },
            getLeaf() {
                return {
                    async openFile(file) {
                        activeFile = file;
                    }
                };
            }
        },
        metadataCache: {
            getFileCache(file) {
                return files.get(file.path).cache || null;
            }
        },
        fileManager: {
            async processFrontMatter(file, callback) {
                const record = files.get(file.path);
                record.cache ||= { frontmatter: {} };
                callback(record.cache.frontmatter);
            }
        }
    };

    return {
        app,
        files,
        setActive(path, frontmatter) {
            activeFile = files.get(path).file;
            files.get(path).cache = { frontmatter };
        }
    };
}

function apiFor({ actions = [], forms = [], wide = [], confirmations = [], confirmationErrors = [] } = {}) {
    return {
        utility: {
            getSelection: () => "",
            getSelectedText: () => "",
            getClipboard: () => ""
        },
        async suggester() {
            return actions.shift();
        },
        async requestInputs() {
            return forms.shift() || {};
        },
        async wideInputPrompt() {
            return wide.shift() || "";
        },
        async yesNoPrompt() {
            const error = confirmationErrors.shift();
            if (error) throw error;
            return confirmations.shift() ?? false;
        }
    };
}

async function execute(app, api, runner = run, obsidian = {}) {
    await runner({
        app,
        quickAddApi: api,
        abort(message) {
            const error = new Error(message);
            error.name = "MacroAbortError";
            throw error;
        },
        obsidian: { Notice: MockNotice, ...obsidian }
    });
}

async function withoutConsoleError(callback) {
    const original = console.error;
    console.error = () => {};
    try {
        return await callback();
    } finally {
        console.error = original;
    }
}

function localDate(offsetDays = 0) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offsetDays);
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

async function testReadingReview() {
    const dailyPath = `_Daily_Tasks/${localDate()}.md`;
    const { app, files } = createApp({ [dailyPath]: "# 今日\n" });
    const api = apiFor({
        actions: ["创建阅读复盘"],
        forms: [{
            year: "2005",
            passage: "Text-1",
            correct: "3",
            minutes: "28",
            error: "定位",
            source: "2005 真题 PDF"
        }],
        wide: ["> ([[paper.pdf#page=1|paper, p.1]])\n> Evidence sentence."]
    });

    await execute(app, api);
    const reading = [...files.values()].find((entry) => entry.content.includes("type: english-reading"));
    const session = [...files.values()].find((entry) => entry.content.includes("type: english-session"));
    assert.ok(reading);
    assert.ok(session);
    assert.match(reading.content, /correct: 3/);
    assert.match(reading.content, /error_tags: \["定位"\]/);
    assert.equal((reading.content.match(/^- \[ \]/gm) || []).length, 4);
    assert.match(session.content, /result: "3\/5"/);
    assert.match(files.get(dailyPath).content, /## 英语记录/);
    assert.match(files.get(dailyPath).content, /english-session:/);
}

async function testWritingReviewAndRewrite() {
    const { app, files, setActive } = createApp();
    const api = apiFor({
        actions: ["创建作文复盘"],
        forms: [{ genre: "大作文", topic: "2018 消费选择", minutes: "32", source: "2018 英语一" }],
        wide: ["描述图画并评论消费选择。"]
    });

    await execute(app, api);
    const writingEntry = [...files.entries()].find(([, entry]) => entry.content.includes("type: english-writing"));
    assert.ok(writingEntry);
    assert.match(writingEntry[1].content, /rewrite_done: false/);
    assert.match(writingEntry[1].content, /- \[ \] 完成自改二稿/);

    const frontmatter = { type: "english-writing", rewrite_due: localDate(1), rewrite_done: false };
    setActive(writingEntry[0], frontmatter);
    await execute(app, apiFor({ actions: ["完成阶段复习"] }));
    assert.equal(frontmatter.rewrite_done, true);
    assert.match(files.get(writingEntry[0]).content, /- \[x\] 完成自改二稿 .* ✅ \d{4}-\d{2}-\d{2}/);
}

async function testSentenceCaptureHasNoAnkiMarkers() {
    const { app, files } = createApp();
    const api = apiFor({
        actions: ["抓取长难句"],
        forms: [{ source: "2010 Text-2", grammar: "非谓语", minutes: "12" }],
        wide: ["> A sentence copied from PDF++."]
    });

    await execute(app, api);
    const sentence = [...files.values()].find((entry) => entry.content.includes("type: english-sentence"));
    assert.ok(sentence);
    assert.doesNotMatch(sentence.content, /^Q:|^A:/m);
    assert.match(sentence.content, /24 小时后遮住原文重译/);
}

async function testAnkiCardIsQaOnly() {
    const { app, files } = createApp();
    const api = apiFor({
        actions: ["制作 Anki 问答卡"],
        forms: [{ kind: "熟词僻义", front: "address 作动词的高频义？", back: "处理、应对（问题）" }]
    });

    await execute(app, api);
    const card = [...files.entries()].find(([path]) => path.startsWith("03 - 英语/Anki/"));
    assert.ok(card);
    assert.equal(card[1].content, "TARGET DECK: 英语\n\nQ: address 作动词的高频义？\nA: 处理、应对（问题）\n\n");
}

async function testDismissedDuplicateCardIsCancellation() {
    MockNotice.messages = [];
    const dailyPath = `03 - 英语/Anki/${localDate()}.md`;
    const { app } = createApp({
        [dailyPath]: "TARGET DECK: 英语\n\nQ: address 作动词的高频义？\nA: 处理、应对（问题）\n"
    });
    const api = apiFor({
        actions: ["制作 Anki 问答卡"],
        forms: [{ kind: "熟词僻义", front: "address 作动词的高频义？", back: "处理、应对（问题）" }],
        confirmationErrors: [new Error("prompt dismissed")]
    });

    await assert.rejects(
        execute(app, api),
        (error) => error && error.name === "MacroAbortError" && /已取消重复卡/.test(error.message)
    );
    assert.deepEqual(MockNotice.messages, []);
}

async function testCompleteReviewSynchronizesTaskAndStatus() {
    const path = "03 - 英语/02 - 真题复盘/阅读/sample.md";
    const { app, files, setActive } = createApp({
        [path]: `---\ntype: english-reading\nreview_1_done: false\n---\n\n## 复习任务\n\n- [ ] 次日遮住答案重做 ⏫ 📅 ${localDate()}\n`
    });
    const frontmatter = { type: "english-reading", review_1: localDate(), review_1_done: false };
    setActive(path, frontmatter);
    const api = apiFor({ actions: ["完成阶段复习", "pass"] });

    await execute(app, api);
    assert.equal(frontmatter.review_1_done, true);
    assert.match(files.get(path).content, /- \[x\] 次日遮住答案重做 .* ✅ \d{4}-\d{2}-\d{2}/);
    assert.match(files.get(path).content, /## 复习记录/);
    assert.match(files.get(path).content, /\| 1 天 \| 通过 \|/);
}

async function testUnstableReviewReschedulesTomorrow() {
    const path = "03 - 英语/02 - 真题复盘/阅读/retry.md";
    const { app, files, setActive } = createApp({
        [path]: `---\ntype: english-reading\nreview_1_done: false\n---\n\n## 复习任务\n\n- [ ] 次日遮住答案重做 ⏫ 📅 ${localDate()}\n`
    });
    const frontmatter = { type: "english-reading", review_1: localDate(), review_1_done: false };
    setActive(path, frontmatter);

    await execute(app, apiFor({ actions: ["完成阶段复习", "retry"] }));
    assert.equal(frontmatter.review_1, localDate(1));
    assert.equal(frontmatter.review_1_done, false);
    assert.match(files.get(path).content, new RegExp(`📅 ${localDate(1)}`));
    assert.match(files.get(path).content, /不稳，顺延 1 天/);
}

async function testFutureReviewCannotCompleteEarly() {
    const path = "03 - 英语/02 - 真题复盘/阅读/future.md";
    const { app, setActive } = createApp({ [path]: "---\ntype: english-reading\n---\n" });
    setActive(path, { type: "english-reading", review_1: localDate(1), review_1_done: false });
    await assert.rejects(
        execute(app, apiFor({ actions: ["完成阶段复习"] })),
        (error) => error && error.name === "MacroAbortError" && /不提前完成/.test(error.message)
    );
}

async function testCancellationPropagatesWithoutFailureNotice() {
    MockNotice.messages = [];
    const { app } = createApp();
    await assert.rejects(
        execute(app, apiFor({ actions: [undefined] })),
        (error) => error && error.name === "MacroAbortError"
    );
    assert.deepEqual(MockNotice.messages, []);
}

async function testDailyLogStaysInsideEnglishSection() {
    const dailyPath = `_Daily_Tasks/${localDate()}.md`;
    const { app, files } = createApp({
        [dailyPath]: "# 今日\n\n## 英语记录\n\n- 旧记录\n\n## 其他记录\n\n- 必须保留\n"
    });
    await execute(app, apiFor({
        actions: ["记录复习会话"],
        forms: [{ kind: "词汇", minutes: "20", amount: "50", source: "词表", result: "完成" }]
    }));

    const content = files.get(dailyPath).content;
    const marker = content.indexOf("english-session:");
    assert.ok(marker > content.indexOf("## 英语记录"));
    assert.ok(marker < content.indexOf("## 其他记录"));
    assert.match(content, /## 其他记录\n\n- 必须保留/);
}

async function testDailyBacklinkFailureDoesNotMisreportSession() {
    MockNotice.messages = [];
    const dailyPath = `_Daily_Tasks/${localDate()}.md`;
    const { app, files } = createApp({ [dailyPath]: "# 今日\n" });
    const originalProcess = app.vault.process;
    app.vault.process = async (file, callback) => {
        if (file.path === dailyPath) throw new Error("simulated daily write failure");
        return originalProcess(file, callback);
    };

    await withoutConsoleError(() => execute(app, apiFor({
        actions: ["记录复习会话"],
        forms: [{ kind: "词汇", minutes: "20", amount: "50", source: "词表", result: "完成" }]
    })));

    assert.ok([...files.values()].some((entry) => entry.content.includes("type: english-session")));
    assert.ok(MockNotice.messages.some((message) => /学习时长已记录.*日记回链失败/.test(message)));
    assert.equal(MockNotice.messages.some((message) => /脚本失败/.test(message)), false);
}

async function testOpenFailureDoesNotMisreportCommittedSession() {
    MockNotice.messages = [];
    const { app, files } = createApp();
    app.workspace.getLeaf = () => ({
        async openFile() {
            throw new Error("simulated open failure");
        }
    });

    await withoutConsoleError(() => execute(app, apiFor({
        actions: ["记录复习会话"],
        forms: [{ kind: "词汇", minutes: "20", amount: "50", source: "词表", result: "完成" }]
    })));

    const sessions = [...files.values()].filter((entry) => entry.content.includes("type: english-session"));
    assert.equal(sessions.length, 1);
    assert.ok(MockNotice.messages.some((message) => /内容已经保存.*自动打开失败/.test(message)));
    assert.equal(MockNotice.messages.some((message) => /脚本失败|请重新运行/.test(message)), false);
}

async function testExplicitZeroAmountIsShownAsZero() {
    const { app, files } = createApp();
    await execute(app, apiFor({
        actions: ["记录复习会话"],
        forms: [{ kind: "词汇", minutes: "20", amount: "0", source: "词表", result: "完成" }]
    }));
    const session = [...files.values()].find((entry) => entry.content.includes("type: english-session"));
    assert.ok(session);
    assert.match(session.content, /amount: 0/);
    assert.match(session.content, /- 数量：0/);
}

async function testReviewHistoryStaysInItsTable() {
    const path = "03 - 英语/02 - 真题复盘/阅读/history.md";
    const { app, files, setActive } = createApp({
        [path]: `---\ntype: english-reading\n---\n\n## 复习任务\n\n- [ ] 次日遮住答案重做 ⏫ 📅 ${localDate()}\n\n## 复习记录\n\n| 日期 | 阶段 | 结果 |\n|---|---:|---|\n| 2026-07-01 | 1 天 | 不稳 |\n\n## 备注\n\n保留此段。\n`
    });
    const frontmatter = { type: "english-reading", review_1: localDate(), review_1_done: false };
    setActive(path, frontmatter);

    await execute(app, apiFor({ actions: ["完成阶段复习", "pass"] }));
    const content = files.get(path).content;
    const newRow = content.indexOf("| 1 天 | 通过 |");
    assert.ok(newRow > content.indexOf("| 2026-07-01 |"));
    assert.ok(newRow < content.indexOf("## 备注"));
    assert.match(content, /## 备注\n\n保留此段。/);
}

async function testMissingTaskDoesNotMutateFrontmatter() {
    MockNotice.messages = [];
    const path = "03 - 英语/02 - 真题复盘/阅读/missing-task.md";
    const { app, files, setActive } = createApp({ [path]: "---\ntype: english-reading\n---\n\n没有任务。\n" });
    const frontmatter = { type: "english-reading", review_1: localDate(), review_1_done: false };
    setActive(path, frontmatter);

    await withoutConsoleError(() => execute(app, apiFor({ actions: ["完成阶段复习", "pass"] })));
    assert.equal(frontmatter.review_1_done, false);
    assert.equal(Object.hasOwn(frontmatter, "last_reviewed"), false);
    assert.doesNotMatch(files.get(path).content, /## 复习记录/);
    assert.ok(MockNotice.messages.some((message) => /YAML 未更新/.test(message)));
}

async function testTaskDateMustMatchFrontmatter() {
    MockNotice.messages = [];
    const path = "03 - 英语/02 - 真题复盘/阅读/date-mismatch.md";
    const { app, files, setActive } = createApp({
        [path]: `---\ntype: english-reading\n---\n\n## 复习任务\n\n- [ ] 次日遮住答案重做 ⏫ 📅 ${localDate(1)}\n`
    });
    const frontmatter = { type: "english-reading", review_1: localDate(), review_1_done: false };
    setActive(path, frontmatter);

    await withoutConsoleError(() => execute(app, apiFor({ actions: ["完成阶段复习", "pass"] })));
    assert.equal(frontmatter.review_1_done, false);
    assert.doesNotMatch(files.get(path).content, /- \[x\]/);
    assert.doesNotMatch(files.get(path).content, /## 复习记录/);
    assert.ok(MockNotice.messages.some((message) => /与 YAML 日期.*一致/.test(message)));
}

async function testBodyFailureRollsBackFrontmatter() {
    MockNotice.messages = [];
    const path = "03 - 英语/02 - 真题复盘/阅读/write-failure.md";
    const { app, setActive } = createApp({
        [path]: `---\ntype: english-reading\n---\n\n## 复习任务\n\n- [ ] 次日遮住答案重做 ⏫ 📅 ${localDate()}\n`
    });
    const frontmatter = { type: "english-reading", review_1: localDate(), review_1_done: false };
    setActive(path, frontmatter);
    app.vault.process = async () => {
        throw new Error("simulated body write failure");
    };

    await withoutConsoleError(() => execute(app, apiFor({ actions: ["完成阶段复习", "pass"] })));
    assert.equal(frontmatter.review_1_done, false);
    assert.equal(Object.hasOwn(frontmatter, "last_reviewed"), false);
    assert.ok(MockNotice.messages.some((message) => /simulated body write failure/.test(message)));
}

async function testRollbackFailureRequestsManualVerification() {
    MockNotice.messages = [];
    const path = "03 - 英语/02 - 真题复盘/阅读/rollback-failure.md";
    const { app, setActive } = createApp({
        [path]: `---\ntype: english-reading\n---\n\n## 复习任务\n\n- [ ] 次日遮住答案重做 ⏫ 📅 ${localDate()}\n`
    });
    const frontmatter = { type: "english-reading", review_1: localDate(), review_1_done: false };
    setActive(path, frontmatter);
    const originalFrontmatterProcess = app.fileManager.processFrontMatter;
    let frontmatterCalls = 0;
    app.fileManager.processFrontMatter = async (file, callback) => {
        frontmatterCalls += 1;
        if (frontmatterCalls === 2) throw new Error("simulated rollback failure");
        return originalFrontmatterProcess(file, callback);
    };
    app.vault.process = async () => {
        throw new Error("simulated body write failure");
    };

    await withoutConsoleError(() => execute(app, apiFor({ actions: ["完成阶段复习", "pass"] })));
    assert.equal(frontmatter.review_1_done, true, "failed rollback leaves YAML requiring manual repair");
    assert.ok(MockNotice.messages.some((message) => /YAML 回滚失败，请立即核对/.test(message)));
}

async function testInvalidCalendarDateIsRejected() {
    const path = "03 - 英语/02 - 真题复盘/阅读/invalid-date.md";
    const { app, setActive } = createApp({ [path]: "---\ntype: english-reading\n---\n" });
    setActive(path, { type: "english-reading", review_1: "2026-99-99", review_1_done: false });
    await assert.rejects(
        execute(app, apiFor({ actions: ["完成阶段复习"] })),
        (error) => error && error.name === "MacroAbortError" && /缺少有效日期/.test(error.message)
    );
}

async function testMissingIntermediateStagesAreSkipped() {
    const path = "03 - 英语/02 - 真题复盘/阅读/legacy-stages.md";
    const { app, files, setActive } = createApp({
        [path]: `---\ntype: english-reading\n---\n\n## 复习任务\n\n- [ ] 第 21 天复核仍不稳的题 📅 ${localDate()}\n`
    });
    const frontmatter = {
        type: "english-reading",
        review_1: "2026-07-01",
        review_1_done: true,
        review_21: localDate(),
        review_21_done: false
    };
    setActive(path, frontmatter);

    await execute(app, apiFor({ actions: ["完成阶段复习", "pass"] }));
    assert.equal(frontmatter.review_21_done, true);
    assert.match(files.get(path).content, /- \[x\] 第 21 天复核仍不稳的题 .* ✅ \d{4}-\d{2}-\d{2}/);
    assert.match(files.get(path).content, /\| 21 天 \| 通过 \|/);
}

async function testCaptureUsesOneSelectionApiBeforeClipboard() {
    const { app, files } = createApp();
    let legacyCalls = 0;
    let promptDefault = null;
    const api = apiFor({
        actions: ["抓取长难句"],
        forms: [{ source: "PDF", grammar: "主干", minutes: "" }]
    });
    api.utility.getSelection = () => "";
    api.utility.getSelectedText = () => {
        legacyCalls += 1;
        throw new Error("legacy getter should not run");
    };
    api.utility.getClipboard = () => "Clipboard sentence.";
    api.wideInputPrompt = async (_title, _description, defaultValue) => {
        promptDefault = defaultValue;
        return defaultValue;
    };

    await execute(app, api);
    assert.equal(legacyCalls, 0);
    assert.equal(promptDefault, "Clipboard sentence.");
    assert.ok([...files.values()].some((entry) => entry.content.includes("Clipboard sentence.")));
}

async function testDuplicateScanUsesBoundedConcurrency() {
    const initial = {};
    for (let index = 0; index < 20; index += 1) {
        initial[`03 - 英语/Anki/2026-07-${String(index + 1).padStart(2, "0")}.md`] = `Q: old-${index}\nA: answer\n`;
    }
    const { app } = createApp(initial);
    const originalRead = app.vault.cachedRead;
    let activeReads = 0;
    let maxReads = 0;
    app.vault.cachedRead = async (file) => {
        activeReads += 1;
        maxReads = Math.max(maxReads, activeReads);
        await new Promise((resolve) => setImmediate(resolve));
        const content = await originalRead(file);
        activeReads -= 1;
        return content;
    };

    await execute(app, apiFor({
        actions: ["制作 Anki 问答卡"],
        forms: [{ kind: "易混词", front: "new-card", back: "answer" }]
    }));
    assert.ok(maxReads > 1, "duplicate scan should read a small batch concurrently");
    assert.ok(maxReads <= 8, "duplicate scan concurrency must remain bounded");
}

function parseTestYaml(source) {
    const result = {};
    for (const line of source.split(/\r?\n/)) {
        const match = line.match(/^([^:#][^:]*):\s*(.*)$/);
        if (!match) continue;
        const key = match[1].trim();
        const value = match[2].trim();
        if (value === "true" || value === "false") result[key] = value === "true";
        else if (/^-?\d+(?:\.\d+)?$/.test(value)) result[key] = Number(value);
        else if (/^".*"$/.test(value)) result[key] = JSON.parse(value);
        else result[key] = value;
    }
    return result;
}

function renderTestYaml(frontmatter) {
    return Object.entries(frontmatter).map(([key, value]) => {
        const encoded = typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value)
            ? JSON.stringify(value)
            : String(value);
        return `${key}: ${encoded}`;
    }).join("\n");
}

async function testConcurrentReviewRunsAreSerializedAcrossScriptLoads() {
    const path = "03 - 英语/02 - 真题复盘/阅读/concurrent.md";
    const initialFrontmatter = {
        type: "english-reading",
        review_1: localDate(),
        review_1_done: false
    };
    const { app, files, setActive } = createApp({
        [path]: `---\n${renderTestYaml(initialFrontmatter)}\n---\n\n## 复习任务\n\n- [ ] 次日遮住答案重做 ⏫ 📅 ${localDate()}\n`
    });
    const staleCache = { ...initialFrontmatter };
    setActive(path, staleCache);
    let diskFrontmatter = { ...initialFrontmatter };
    let writes = 0;
    app.vault.read = async (file) => files.get(file.path).content;
    app.fileManager.processFrontMatter = async (file, callback) => {
        const next = { ...diskFrontmatter };
        callback(next);
        if (writes === 0) await new Promise((resolve) => setTimeout(resolve, 20));
        writes += 1;
        diskFrontmatter = next;
        const record = files.get(file.path);
        record.content = record.content.replace(
            /^---\r?\n[\s\S]*?\r?\n---/,
            `---\n${renderTestYaml(diskFrontmatter)}\n---`
        );
    };

    const first = execute(
        app,
        apiFor({ actions: ["完成阶段复习", "pass"] }),
        loadFreshRun(),
        { parseYaml: parseTestYaml }
    );
    await new Promise((resolve) => setImmediate(resolve));
    const second = execute(
        app,
        apiFor({ actions: ["完成阶段复习", "retry"] }),
        loadFreshRun(),
        { parseYaml: parseTestYaml }
    );
    const results = await Promise.allSettled([first, second]);

    assert.deepEqual(results.map((item) => item.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(diskFrontmatter.review_1_done, true);
    assert.equal(staleCache.review_1_done, false, "the test cache must remain stale");
    const content = files.get(path).content;
    assert.match(content, /- \[x\] 次日遮住答案重做 .* ✅ \d{4}-\d{2}-\d{2}/);
    assert.equal((content.match(/\| 1 天 \| 通过 \|/g) || []).length, 1);
    assert.doesNotMatch(content, /不稳，顺延 1 天/);
}

async function testFreshFrontmatterAcceptsBomAndClosingWhitespace() {
    const cases = [
        { name: "bom", opening: "\uFEFF---", closing: "---" },
        { name: "closing-space", opening: "---", closing: "---   " }
    ];

    for (const sample of cases) {
        MockNotice.messages = [];
        const path = `03 - 英语/02 - 真题复盘/阅读/${sample.name}.md`;
        const frontmatter = {
            type: "english-reading",
            review_1: localDate(),
            review_1_done: false
        };
        const { app, files, setActive } = createApp({
            [path]: `${sample.opening}\n${renderTestYaml(frontmatter)}\n${sample.closing}\n\n`
                + `## 复习任务\n\n- [ ] 次日遮住答案重做 ⏫ 📅 ${localDate()}\n`
        });
        setActive(path, { ...frontmatter });
        app.vault.read = async (file) => files.get(file.path).content;

        await execute(
            app,
            apiFor({ actions: ["完成阶段复习", "pass"] }),
            run,
            { parseYaml: parseTestYaml }
        );

        assert.match(files.get(path).content, /- \[x\] 次日遮住答案重做/);
        assert.equal(MockNotice.messages.some((message) => /脚本失败/.test(message)), false);
    }
}

(async () => {
    await testReadingReview();
    await testWritingReviewAndRewrite();
    await testSentenceCaptureHasNoAnkiMarkers();
    await testAnkiCardIsQaOnly();
    await testDismissedDuplicateCardIsCancellation();
    await testCompleteReviewSynchronizesTaskAndStatus();
    await testUnstableReviewReschedulesTomorrow();
    await testFutureReviewCannotCompleteEarly();
    await testCancellationPropagatesWithoutFailureNotice();
    await testDailyLogStaysInsideEnglishSection();
    await testDailyBacklinkFailureDoesNotMisreportSession();
    await testOpenFailureDoesNotMisreportCommittedSession();
    await testExplicitZeroAmountIsShownAsZero();
    await testReviewHistoryStaysInItsTable();
    await testMissingTaskDoesNotMutateFrontmatter();
    await testTaskDateMustMatchFrontmatter();
    await testBodyFailureRollsBackFrontmatter();
    await testRollbackFailureRequestsManualVerification();
    await testInvalidCalendarDateIsRejected();
    await testMissingIntermediateStagesAreSkipped();
    await testCaptureUsesOneSelectionApiBeforeClipboard();
    await testDuplicateScanUsesBoundedConcurrency();
    await testConcurrentReviewRunsAreSerializedAcrossScriptLoads();
    await testFreshFrontmatterAcceptsBomAndClosingWhitespace();
    console.log("english-review-actions: 24 tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
