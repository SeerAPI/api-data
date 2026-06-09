/// <reference types="node" />
import { getStore, type Store } from "@edgeone/pages-blob";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const DEFAULT_IGNORE_DIRS = new Set([".git", "node_modules"]);

const TEXT_EXTENSIONS = new Set([
    ".txt",
    ".md",
    ".csv",
    ".xml",
    ".html",
    ".htm",
    ".css",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".json",
    ".yaml",
    ".yml",
    ".svg",
    ".sql",
]);

interface CliOptions {
    localDir: string;
    blobPrefix: string;
    storeName: string;
    dryRun: boolean;
    onlyIfNew: boolean;
    compressJson: boolean;
    concurrency: number;
}

function printUsage(): void {
    console.log(`用法:
  npx tsx test.ts <本地目录> [blob前缀] [选项]

选项:
  --store <名称>       Blob 命名空间，默认 BLOB_STORE_NAME 或 test-store
  --prefix <前缀>      Blob key 前缀（也可用第二个位置参数）
  --dry-run            只列出将要上传的文件，不实际上传
  --only-if-new        仅当 key 不存在时写入
  --no-compress-json   上传 JSON 时不压缩（默认会去除格式化空白）
  --concurrency <n>    并发上传数，默认 5

环境变量（本地脚本必填 token）:
  BLOB_TOKEN           API Token（必填）
  BLOB_PROJECT_ID      项目 ID（可选，默认读取 .edgeone/project.json）
  BLOB_STORE_NAME      命名空间名称

示例:
  npx tsx test.ts ./data data/
  npx tsx test.ts achievement_id.json data/achievement/id.json --prefix ""
`);
}

function parseArgs(argv: string[]): CliOptions | null {
    if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
        printUsage();
        return null;
    }

    const positional: string[] = [];
    let blobPrefix = "";
    let storeName = process.env.BLOB_STORE_NAME ?? "test-store";
    let dryRun = false;
    let onlyIfNew = false;
    let compressJson = true;
    let concurrency = 5;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        switch (arg) {
            case "--store": {
                const value = argv[++i];
                if (!value) throw new Error("--store 需要指定命名空间名称");
                storeName = value;
                break;
            }
            case "--prefix": {
                const value = argv[++i];
                if (value === undefined) throw new Error("--prefix 需要指定前缀");
                blobPrefix = value;
                break;
            }
            case "--dry-run":
                dryRun = true;
                break;
            case "--only-if-new":
                onlyIfNew = true;
                break;
            case "--no-compress-json":
                compressJson = false;
                break;
            case "--concurrency": {
                const raw = argv[++i];
                const n = Number(raw);
                if (!raw || !Number.isFinite(n) || n < 1) {
                    throw new Error("--concurrency 必须是大于 0 的整数");
                }
                concurrency = Math.floor(n);
                break;
            }
            default:
                if (arg.startsWith("-")) {
                    throw new Error(`未知选项: ${arg}`);
                }
                positional.push(arg);
        }
    }

    if (positional.length === 0) {
        printUsage();
        return null;
    }

    const localDirArg = positional[0];
    if (!localDirArg) {
        printUsage();
        return null;
    }

    const localDir = resolve(localDirArg);
    if (positional[1] !== undefined && blobPrefix === "") {
        blobPrefix = positional[1];
    }

    if (blobPrefix && !blobPrefix.endsWith("/")) {
        blobPrefix += "/";
    }

    return { localDir, blobPrefix, storeName, dryRun, onlyIfNew, compressJson, concurrency };
}

async function loadProjectId(): Promise<string> {
    if (process.env.BLOB_PROJECT_ID) {
        return process.env.BLOB_PROJECT_ID;
    }
    try {
        const raw = await readFile(".edgeone/project.json", "utf-8");
        const config = JSON.parse(raw) as { ProjectId?: string };
        if (config.ProjectId) {
            return config.ProjectId;
        }
    } catch {
        // ignore
    }
    throw new Error("请设置环境变量 BLOB_PROJECT_ID，或确保 .edgeone/project.json 包含 ProjectId");
}

async function collectFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        if (entry.isDirectory() && DEFAULT_IGNORE_DIRS.has(entry.name)) {
            continue;
        }
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectFiles(fullPath)));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }

    return files;
}

function toBlobKey(localRoot: string, filePath: string, prefix: string): string {
    const rel = relative(localRoot, filePath).split("\\").join("/");
    return prefix ? `${prefix}${rel}` : rel;
}

/** 解析后重新序列化，去除缩进、换行等格式化空白 */
function compressJson(text: string): string {
    return JSON.stringify(JSON.parse(text) as unknown);
}

async function uploadFile(
    store: Store,
    localRoot: string,
    filePath: string,
    prefix: string,
    onlyIfNew: boolean,
    compressJsonEnabled: boolean,
): Promise<string> {
    const key = toBlobKey(localRoot, filePath, prefix);
    const options = onlyIfNew ? { onlyIfNew: true as const } : undefined;

    if (extname(filePath).toLowerCase() === ".json") {
        const text = await readFile(filePath, "utf-8");
        if (compressJsonEnabled) {
            await store.set(key, compressJson(text), options);
        } else {
            await store.setJSON(key, JSON.parse(text) as unknown, options);
        }
        return key;
    }

    const buffer = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();

    if (TEXT_EXTENSIONS.has(ext)) {
        await store.set(key, buffer.toString("utf-8"), options);
    } else {
        await store.set(
            key,
            buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
            options,
        );
    }

    return key;
}

async function runPool<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
    let nextIndex = 0;

    async function runner(): Promise<void> {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) {
                return;
            }
            await worker(items[index]!, index);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, () => runner()),
    );
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (!options) {
        return;
    }

    const token = process.env.BLOB_TOKEN;
    if (!token && !options.dryRun) {
        throw new Error("请设置环境变量 BLOB_TOKEN（可在控制台 Blob 页面创建 API Token）");
    }

    const dirStat = await stat(options.localDir).catch(() => null);
    if (!dirStat) {
        throw new Error(`目录不存在: ${options.localDir}`);
    }

    const projectId = options.dryRun ? "" : await loadProjectId();
    const store = options.dryRun
        ? null
        : getStore({
            name: options.storeName,
            projectId,
            token: token!,
        });

    const files = dirStat.isDirectory()
        ? await collectFiles(options.localDir)
        : [options.localDir];

    const firstFile = files[0];
    if (!firstFile) {
        console.log("没有找到可上传的文件");
        return;
    }
    const localRoot = dirStat.isDirectory() ? options.localDir : resolve(firstFile, "..");

    if (files.length === 0) {
        console.log("没有找到可上传的文件");
        return;
    }

    console.log(
        `${options.dryRun ? "[dry-run] " : ""}上传 ${files.length} 个文件 → store "${options.storeName}"，前缀 "${options.blobPrefix}"${options.compressJson ? "，JSON 压缩已启用" : ""}`,
    );

    let ok = 0;
    let failed = 0;

    await runPool(files, options.concurrency, async (filePath) => {
        const key = toBlobKey(localRoot, filePath, options.blobPrefix);
        try {
            if (options.dryRun) {
                console.log(`  ${filePath} → ${key}`);
            } else {
                await uploadFile(
                    store!,
                    localRoot,
                    filePath,
                    options.blobPrefix,
                    options.onlyIfNew,
                    options.compressJson,
                );
                ok++;
                console.log(`✓ ${key}`);
            }
        } catch (err) {
            failed++;
            const message = err instanceof Error ? err.message : String(err);
            console.error(`✗ ${key}: ${message}`);
        }
    });

    if (!options.dryRun) {
        console.log(`完成: 成功 ${ok}，失败 ${failed}`);
        if (failed > 0) {
            process.exitCode = 1;
        }
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
