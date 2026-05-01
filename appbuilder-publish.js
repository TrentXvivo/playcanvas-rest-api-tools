const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REQUIRED_MODULES = ['adm-zip', 'base64-js', 'dotenv', 'node-fetch'];
const EXCLUDE_FILE_EXTENSIONS_FROM_BASE64 = ['.mp4'];

function logEvent(event, payload, level) {
    const row = {
        ts: new Date().toISOString(),
        level: level || 'info',
        event,
        ...(payload || {})
    };
    console.log(JSON.stringify(row));
}

function parseArgs(argv) {
    let outputRoot = '';

    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--output') {
            outputRoot = argv[i + 1] || '';
            i += 1;
        }
    }

    if (!outputRoot || !outputRoot.trim()) {
        throw new Error('Missing required argument --output <path>');
    }

    return {
        outputRoot: path.resolve(outputRoot.trim())
    };
}

function moduleExists(moduleName) {
    try {
        require.resolve(moduleName, { paths: [__dirname] });
        return true;
    } catch {
        return false;
    }
}

function installModule(moduleName) {
    const npmExec = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npmExec, ['install', moduleName, '--no-save'], {
        cwd: __dirname,
        encoding: 'utf8'
    });

    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `npm install failed for ${moduleName}`);
    }
}

function runPreflight() {
    const missing = REQUIRED_MODULES.filter((moduleName) => !moduleExists(moduleName));
    if (missing.length === 0) {
        logEvent('preflight.ok', { checked: REQUIRED_MODULES.length });
        return;
    }

    logEvent('preflight.missing', { modules: missing });

    for (const moduleName of missing) {
        logEvent('preflight.install.start', { module: moduleName });
        installModule(moduleName);
        logEvent('preflight.install.complete', { module: moduleName });
    }

    logEvent('preflight.complete', { installed: missing.length });
}

function normalizeVersion(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    if (/^v\d+\.\d+\.\d+$/i.test(raw)) {
        return raw.toLowerCase();
    }

    if (/^\d+\.\d+\.\d+$/.test(raw)) {
        return `v${raw}`;
    }

    return '';
}

function slugifyName(value) {
    const slug = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    return slug || 'project';
}

function resolveOutputNaming(config) {
    const playcanvas = config.playcanvas || {};
    const rawName = String(playcanvas.name || 'project').trim();
    let projectName = rawName || 'project';
    let version = normalizeVersion(playcanvas.version);

    if (!version) {
        const match = projectName.match(/^(.*)_(v?\d+\.\d+\.\d+)$/i);
        if (match && match[1]) {
            projectName = match[1].trim() || projectName;
            version = normalizeVersion(match[2]);
        }
    }

    if (!version) {
        version = 'v0.0.0';
    }

    const projectSlug = slugifyName(projectName);
    const outputFolderName = `${projectSlug}_${version}`;

    return {
        projectName,
        projectSlug,
        version,
        outputFolderName
    };
}

function isAudioTransformEnabled(config) {
    const appbuilder = config.appbuilder || {};
    const value = appbuilder.audio_transform;
    if (typeof value === 'boolean') {
        return value;
    }

    return String(value || '').toLowerCase() === 'true';
}

function injectCordovaScript(projectPath) {
    const indexLocation = path.resolve(projectPath, 'index.html');
    if (!fs.existsSync(indexLocation)) {
        throw new Error('index.html not found in downloaded build');
    }

    let indexContents = fs.readFileSync(indexLocation, 'utf-8');
    if (!indexContents.includes('cordova.js')) {
        indexContents = indexContents.replace(
            '<script src="playcanvas-stable.min.js"></script>',
            '<script src="playcanvas-stable.min.js"></script>\n    <script src="cordova.js"></script>'
        );
    }

    fs.writeFileSync(indexLocation, indexContents);
}

function base64EncodeAudioAssets(projectPath) {
    const base64js = require('base64-js');

    const configLocation = path.resolve(projectPath, 'config.json');
    if (!fs.existsSync(configLocation)) {
        throw new Error('config.json not found in downloaded build');
    }

    const contents = fs.readFileSync(configLocation, 'utf-8');
    const configJson = JSON.parse(contents);
    const assets = configJson.assets || {};
    let transformed = 0;
    let skipped = 0;

    for (const key of Object.keys(assets)) {
        const asset = assets[key];

        if (!asset || !asset.file || asset.type !== 'audio') {
            continue;
        }

        const url = unescape(asset.file.url || '');
        const extension = path.extname(url).toLowerCase();
        if (EXCLUDE_FILE_EXTENSIONS_FROM_BASE64.includes(extension)) {
            skipped += 1;
            continue;
        }

        const filePath = path.resolve(projectPath, url);
        if (!fs.existsSync(filePath)) {
            skipped += 1;
            continue;
        }

        const fileContents = fs.readFileSync(filePath);
        const bytes = Uint8Array.from(fileContents);
        const b64 = base64js.fromByteArray(bytes);

        asset.file.url = `data:application/octet-stream;base64,${b64}`;
        asset.file.hash = '';

        fs.unlinkSync(filePath);
        transformed += 1;
    }

    fs.writeFileSync(configLocation, JSON.stringify(configJson));
    return { transformed, skipped };
}

function copyOutput(sourcePath, outputPath) {
    if (fs.existsSync(outputPath)) {
        fs.rmSync(outputPath, { recursive: true, force: true });
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.cpSync(sourcePath, outputPath, { recursive: true, force: true });
}

function writeManifest(manifestPath, payload) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2), 'utf8');
}

async function run() {
    const startedAt = new Date().toISOString();
    let outputRoot = '';
    let outputPath = '';
    let manifestPath = '';

    try {
        const args = parseArgs(process.argv.slice(2));
        outputRoot = args.outputRoot;
        manifestPath = path.join(outputRoot, 'publish-manifest.json');

        runPreflight();

        const shared = require('./shared');
        const config = shared.readConfig();
        const naming = resolveOutputNaming(config);
        outputPath = path.join(outputRoot, naming.outputFolderName);
        const audioTransformEnabled = isAudioTransformEnabled(config);

        logEvent('publish.start', {
            script: 'appbuilder-publish',
            outputRoot,
            outputPath,
            project: naming.projectName,
            version: naming.version,
            audioTransform: audioTransformEnabled
        });

        fs.mkdirSync(outputRoot, { recursive: true });

        const zipLocation = await shared.downloadProject(config, 'temp/downloads');
        logEvent('publish.download.complete', { zipLocation });

        const extractedRoot = await shared.unzipProject(zipLocation, 'contents');
        logEvent('publish.unzip.complete', { extractedRoot });

        injectCordovaScript(extractedRoot);
        logEvent('publish.patch.cordovaInjected', { outputPath: extractedRoot });

        if (audioTransformEnabled) {
            const audioSummary = base64EncodeAudioAssets(extractedRoot);
            logEvent('publish.patch.audioBase64', audioSummary);
        } else {
            logEvent('publish.patch.audioBase64.skipped', { reason: 'disabled-by-default' });
        }

        copyOutput(extractedRoot, outputPath);
        logEvent('publish.output.ready', { outputPath });

        const successManifest = {
            script: 'appbuilder-publish',
            status: 'success',
            startedAt,
            finishedAt: new Date().toISOString(),
            outputRoot,
            outputPath,
            project: naming.projectName,
            projectSlug: naming.projectSlug,
            version: naming.version,
            audioTransform: audioTransformEnabled
        };

        writeManifest(manifestPath, successManifest);
        logEvent('publish.success', { manifestPath, outputPath });
    } catch (error) {
        const failedManifest = {
            script: 'appbuilder-publish',
            status: 'failed',
            startedAt,
            finishedAt: new Date().toISOString(),
            outputRoot,
            outputPath,
            error: {
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            }
        };

        if (manifestPath) {
            writeManifest(manifestPath, failedManifest);
        }

        logEvent('publish.failed', {
            message: error instanceof Error ? error.message : String(error),
            outputPath,
            manifestPath
        }, 'error');
        process.exitCode = 1;
    }
}

run();