/**
 * `clens install <lang>`
 *
 * Downloads what a language's analyzer needs into its model dir, then
 * reindexes so the newly available adapter is used immediately. Korean's is
 * Kiwi's model (kiwi-nlp, a dependency, ships without it); Japanese's and
 * Chinese's are their whole Lindera packages, whose dictionaries are embedded
 * in the WASM binary (see LINDERA_PACKAGES in indexer/lang/init.ts).
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { runIndex } from "../indexer/driver.js";
import { LINDERA_PACKAGES } from "../indexer/lang/init.js";
import { languageModelDir } from "../util/paths.js";
const execFileAsync = promisify(execFile);
// Verified working with this project's installed kiwi-nlp@0.23.0 WASM
// binding throughout development (see indexer/lang/ko.ts, lang_ko_real.spec.ts).
// Not derived from the installed kiwi-nlp package version — Kiwi's model
// releases and the kiwi-nlp npm binding's version numbers aren't in
// lockstep (the binding here is 0.23.0; this is the 0.23.2 model release).
// Bumping kiwi-nlp later means re-verifying this URL still produces a
// working model, not assuming a same-numbered release exists or works.
const KIWI_MODEL_URL = "https://github.com/bab2min/Kiwi/releases/download/v0.23.2/kiwi_model_v0.23.2_base.tgz";
// Verified directly via `tar tzf` against the real release asset: the
// model files live under this nested path inside the tarball, not at its root.
const KIWI_MODEL_TAR_SUBDIR = "models/cong/base";
async function installKorean() {
    const targetDir = languageModelDir("ko");
    const tmp = await mkdtemp(join(tmpdir(), "clens-kiwi-model-"));
    try {
        const tarPath = join(tmp, "model.tgz");
        process.stderr.write(`clens install ko: downloading ${KIWI_MODEL_URL}\n`);
        const res = await fetch(KIWI_MODEL_URL);
        if (!res.ok) {
            throw new Error(`download failed: HTTP ${res.status}`);
        }
        await writeFile(tarPath, Buffer.from(await res.arrayBuffer()));
        const extractDir = join(tmp, "extracted");
        await mkdir(extractDir, { recursive: true });
        process.stderr.write(`clens install ko: extracting\n`);
        await execFileAsync("tar", ["xzf", tarPath, "-C", extractDir]);
        const modelFilesDir = join(extractDir, KIWI_MODEL_TAR_SUBDIR);
        await mkdir(targetDir, { recursive: true });
        for (const name of await readdir(modelFilesDir)) {
            await rename(join(modelFilesDir, name), join(targetDir, name));
        }
    }
    finally {
        await rm(tmp, { recursive: true, force: true });
    }
}
/** npm's arguments to install a Lindera package under `dir`, a model dir
 *  that is not a project: nothing is saved to a package.json. */
export function linderaInstallArgs(code, dir) {
    const { name, version } = LINDERA_PACKAGES[code];
    return ["install", "--prefix", dir, "--no-save", "--no-audit", "--no-fund", `${name}@${version}`];
}
/** npm's own CLI run through this node, as plugin/start.mjs runs it, so a
 *  missing or different `npm` on PATH does not matter. */
function npm(args) {
    const beside = process.platform === "win32"
        ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
        : join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    const [file, argv] = existsSync(beside)
        ? [process.execPath, [beside, ...args]]
        : [process.platform === "win32" ? "npm.cmd" : "npm", args];
    const shell = process.platform === "win32" && file === "npm.cmd";
    // cmd.exe gets the arguments joined unquoted, and the model dir can hold a space.
    execFileSync(file, shell ? argv.map((a) => `"${a}"`) : argv, { stdio: ["ignore", 2, 2], shell });
}
function linderaInstaller(code) {
    return async () => {
        const dir = languageModelDir(code);
        process.stderr.write(`clens install ${code}: installing ${LINDERA_PACKAGES[code].name} into ${dir}\n`);
        await mkdir(dir, { recursive: true });
        npm(linderaInstallArgs(code, dir));
    };
}
const INSTALLERS = {
    ko: installKorean,
    ja: linderaInstaller("ja"),
    zh: linderaInstaller("zh"),
};
export async function installCommand(flags) {
    const installer = INSTALLERS[flags.lang];
    if (!installer) {
        process.stderr.write(`clens install: unsupported language '${flags.lang}' — one of ${Object.keys(INSTALLERS).join(", ")}.\n`);
        return 2;
    }
    try {
        await installer();
    }
    catch (e) {
        const err = e;
        process.stderr.write(`clens install ${flags.lang}: failed: ${err.message ?? e}\n`);
        return 1;
    }
    process.stderr.write(`clens install ${flags.lang}: model installed, reindexing...\n`);
    const result = await runIndex({ rebuild: true });
    process.stderr.write(`clens install ${flags.lang}: done. parsed ${result.files_parsed}/${result.files_total} files, ` +
        `${result.events_inserted} events, ${result.elapsed_ms}ms. ` +
        `Close every open Claude Code and Codex session and start again to use it.\n`);
    return 0;
}
//# sourceMappingURL=install_cmd.js.map