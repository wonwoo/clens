/**
 * `clens install <lang>`
 *
 * Downloads the external model files a language adapter needs but doesn't
 * bundle in its npm package, then reindexes so the newly available adapter
 * is used immediately. Currently only "ko" needs this — kiwi-nlp's model
 * isn't part of the npm package (unlike ja/zh's Lindera packages, whose
 * dictionaries are embedded in the WASM binary and work with no install
 * step at all; see indexer/lang/init.ts).
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runIndex } from "../indexer/driver.js";
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
const INSTALLERS = {
    ko: installKorean,
};
export async function installCommand(flags) {
    const installer = INSTALLERS[flags.lang];
    if (!installer) {
        process.stderr.write(`clens install: unsupported language '${flags.lang}' — only 'ko' currently needs a separate ` +
            `install step (ja/zh dictionaries are embedded in their npm packages and work automatically).\n`);
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
        `${result.events_inserted} events, ${result.elapsed_ms}ms\n`);
    return 0;
}
//# sourceMappingURL=install_cmd.js.map