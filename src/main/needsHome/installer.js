/*
Copyright (c) 2019 Matt Worzala <bhop.me>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

const fs = require('fs-extra');
const path = require('path');
const files = require('../util/files');
const lzma = require('lzma-purejs');
const fetch = require('node-fetch');
const cache = require('../game/versionCache');
const config = require('../config/config');
const fabric = require('../util/fabric');
const workers = require('../worker/workers_old');
const lock = require('../util/lockfile');
const reporter = require('../app/reporter');

const baseDir = require('electron').app.getPath('userData');
const tempDir = path.join(baseDir, 'temp');
const installDir = path.join(baseDir, 'Install');
const libDir = path.join(installDir, 'libraries');
const instanceDir = config.getValue('minecraft/instanceDir');

fs.mkdirs(tempDir);

const sendTaskUpdate = (id, task, progress) => require('./profile').sendTaskUpdate(id, task, progress);

//todo needs redo
exports.installBaseGame = async (platform = 'win32', modern = true) => {
    const launcherPath = path.join(installDir, `minecraft.${platform === 'win32' ? 'exe' : 'jar'}`);
    if (await fs.pathExists(launcherPath))
        return false;

    if (platform !== 'win32' && modern) {
        console.log('Cannot install native minecraft launcher for any os other than windows!');
        return false;
    }

    if (!modern) {
        console.log('Installing legacy Minecraft launcher.');
        const compressedPath = path.join(tempDir, 'launcher.jar.lzma');
        await files.download('http://launcher.mojang.com/mc/launcher/jar/fa896bd4c79d4e9f0d18df43151b549f865a3db6/launcher.jar.lzma', compressedPath);
        fs.writeFileSync(launcherPath, lzma.decompressFile(fs.readFileSync(compressedPath)));
        await fs.remove(compressedPath);
        return true;
    }

    if (platform === 'win32') {
        console.log('Installing native Minecraft launcher.');
        await files.download('https://launcher.mojang.com/download/Minecraft.exe', launcherPath);
        return true;
    }
};

exports.installVanilla = async (version, task, force) => {
    const dir = path.join(installDir, 'versions', version);

    // Create version directory and find the version json
    console.log(`Installing (or validating) Minecraft ${version}`);
    if (await fs.pathExists(dir) && !force)
        return version;

    fs.mkdirs(dir);
    const vanilla = await (await fetch(cache.findGameVersion(version).url)).json();

    try {
        // Write version json
        console.log('Writing version json...');
        sendTaskUpdate(task, 'writing profile settings', 1/3);
        const jsonLoc = path.join(dir, `${version}.json`);
        if (!await fs.pathExists(jsonLoc))
            await files.download(cache.findGameVersion(version).url, jsonLoc);
        // Download client jar
        sendTaskUpdate(task, 'writing profile settings', 2/3);
        const clientJar = path.join(dir, `${version}.jar`);
        if (!await fs.pathExists(clientJar) || (await files.fileChecksum(clientJar, 'sha1')) !== vanilla.downloads.client.sha1)
            await files.download(vanilla.downloads.client.url, clientJar);
    } catch (e) {
        reporter.error(e);
    }

    // Download asset index
    sendTaskUpdate(task, 'writing profile settings', 3/3);
    const assetIndex = path.join(installDir, 'assets', 'indexes', `${vanilla.assetIndex.id}.json`);
    try {
        if (!await fs.pathExists(assetIndex) || (await files.fileChecksum(assetIndex, 'sha1')) !== vanilla.assetIndex.sha1) {
            console.log(`Downloading asset index to ${assetIndex}...`);
            await files.download(vanilla.assetIndex.url, assetIndex);
        }
    } catch (e) {
        reporter.error(e);
    }

    // Download assets
    await validateGameAssets(task, (await fs.readJson(assetIndex)).objects);

    // Download logger config
    const logConfig = path.join(installDir, 'assets', 'log_configs', vanilla.logging.client.file.id);
    try {
        if (!await fs.pathExists(logConfig) || (await files.fileChecksum(logConfig, 'sha1')) !== vanilla.logging.client.file.sha1) {
            console.log(`Downloading log config to ${logConfig}...`);
            await files.download(vanilla.logging.client.file.url, logConfig);
        }
    } catch (e) {
        reporter.error(e);
    }

    // Download libraries
    await validateTypeOneLibraries(task, 'validating vanilla libraries', vanilla.libraries);

    return version;
};

exports.installForge = async (version, task, force) => {
    const forge = await (await fetch(`https://addons-ecs.forgesvc.net/api/v2/minecraft/modloader/${version}`)).json();
    const afterOneFourteen = parseInt(forge.minecraftVersion.split('.')[1]) >= 14;

    // Create version directory and fetch version info.
    const realName = afterOneFourteen ? `${forge.minecraftVersion}-${forge.name}` : version;
    const dir = path.join(installDir, 'versions', realName);

    if (await fs.pathExists(dir) && !force)
        return realName;

    await fs.mkdirs(dir);
    let versionJson = JSON.parse(forge.versionJson);
    versionJson.id = realName;

    await this.installVanilla(forge.minecraftVersion, task);

    if (afterOneFourteen) {
        // Extra tasks - todo check if older versions have this as well.
        const installerJson = JSON.parse(forge.installProfileJson);

        delete versionJson.jar;
        delete versionJson.minimumLauncherVersion;
        versionJson.logging = {};

        const lockfile = path.join(dir, 'version-lock');
        if (!await lock.check(lockfile)) {
            lock.lock(lockfile, { stale: 300000 });
            try {
                // Write version json
                sendTaskUpdate(task, 'writing version settings', 1/2);
                const versionJsonPath = path.join(dir, `${realName}.json`);
                if (!await fs.pathExists(versionJsonPath))
                    await fs.writeJson(versionJsonPath, versionJson);


                sendTaskUpdate(task, 'writing profile settings', 2/2);
                const clientJar = path.join(dir, `${realName}.jar`);
                if (!await fs.pathExists(clientJar))
                    await fs.copy(path.join(installDir, 'versions', forge.minecraftVersion, `${forge.minecraftVersion}.jar`), clientJar);
            } finally {
                //todo error handling
                await lock.unlock(lockfile);
            }
        } else {
            console.log('Skipping forge >1.14 version json & jar due to existing lock.')
        }

        const libraries = versionJson.libraries.concat(installerJson.libraries);
        await validateTypeOneLibraries(task, 'validating forge versions', libraries);

        await runForgeProcessors(task, installerJson.processors, installerJson.data, forge.minecraftVersion, forge.forgeVersion);
    } else {
        versionJson.jar = forge.minecraftVersion;

        const lockfile = path.join(dir, 'version-lock');
        if (!await lock.check(lockfile)) {
            lock.lock(lockfile, { stale: 300000 });
            try {
                // Write version json
                sendTaskUpdate(task, 'writing version settings', 1);
                const versionJsonPath = path.join(dir, `${realName}.json`);
                if (!await fs.pathExists(versionJsonPath))
                    await fs.writeJson(versionJsonPath, versionJson);
            } finally {
                //todo error handling
                await lock.unlock(lockfile);
            }
        } else {
            console.log('Skipping forge <1.14 version json due to existing lock')
        }

        await validateTypeTwoLibraries(task, 'validating forge libraries', versionJson.libraries);
    }

    return realName;
};

exports.installFabric = async (mappings, loader, task, force) => {
    const version = fabric.fabricify(mappings);
    const versionName = `${fabric.LOADER_NAME}-${loader}-${version.version}`;
    const versionDir = path.join(installDir, 'versions', versionName);

    if (await fs.pathExists(versionDir) && !force)
        return versionName;

    // Install corresponding vanilla version.
    await this.installVanilla(version.minecraftVersion, task);

    let versionJson = await fabric.getLaunchMeta(loader);
    versionJson.id = versionName;
    versionJson.inheritsFrom = version.minecraftVersion;

    versionJson.libraries.push({ name: `${fabric.PACKAGE_NAME.replace('/', '.')}:${fabric.MAPPINGS_NAME}:${version.version}`, url: fabric.MAVEN_SERVER_URL });
    versionJson.libraries.push({ name: `${fabric.PACKAGE_NAME.replace('/', '.')}:${fabric.LOADER_NAME}:${loader}`, url: fabric.MAVEN_SERVER_URL });

    const versionJsonPath = path.join(versionDir, `${versionName}.json`);
    const versionJarPath = path.join(versionDir, `${versionName}.jar`);

    const lockfile = path.join(versionDir, 'version-lock');
    if (!await lock.check(lockfile)) {
        await lock.lock(lockfile, { stale: 300000 });
        try {
            // Empty jar to trick the launcher into thinking this is a valid version.
            await fs.ensureFile(versionJarPath);
            await fs.writeJson(versionJsonPath, versionJson);
        } catch (e) {
            reporter.error(e);
        } finally {
            await lock.unlock(lockfile);
        }
    } else {
        console.log('Skipping fabric version json & jar due to existing lock.')
    }

    await validateTypeTwoLibraries(task, 'validating fabric libraries', versionJson.libraries);

    return versionName;
};

exports.installCurseModpack = async (task, name, fileUrl) => {
    const profileDir = path.join(instanceDir, name);
    const readDir = path => new Promise((resolve, reject) => { fs.readdir(path, (err, items) => { if (err) reject(err); else resolve(items); }); });

    const zipLoc = path.join(tempDir, `${name}.zip`);
    sendTaskUpdate(task, 'preparing', 0/2);
    await files.download(fileUrl, zipLoc);
    sendTaskUpdate(task, 'preparing', 1/2);
    const dir = await files.unzip(zipLoc);
    const manifest = await fs.readJson(path.join(dir, 'manifest.json'));
    sendTaskUpdate(task, 'preparing', 2/2);

    // Copy overrides
    const overridesDir = path.join(dir, manifest.overrides);
    const overrides = await readDir(overridesDir);
    await curseCopyOverrides(task, profileDir, overridesDir, overrides);

    // Install primary modloader
    let localVersionId;
    let forgeVersion;
    for (let i = 0; i < manifest.minecraft.modLoaders.length; i++) {
        const modloader = manifest.minecraft.modLoaders[i];
        console.log(modloader);
        if (modloader.primary) { //todo this is limited to just forge right now, will need to see what is changed to allow for fabric.
            forgeVersion = modloader.id;
            localVersionId = await this.installForge(modloader.id, task);
        }
    }
    if (localVersionId === undefined) {
        console.log('NO VALID MODLOADER HAS BEEN FOUND!!!');
        //todo this should display error and clean up.
        return;
    }

    // Download mods
    const mods = manifest.files;
    await curseInstallMods(task, profileDir, mods);

    // cleanup temporary folder.
    await fs.remove(dir);
    return {
        localVersionId,
        version: {
            version: manifest.minecraft.version,
            flavor: 'forge',
            forge: forgeVersion
        }
    };
};

// Helper Functions

const validateGameAssets = (task, objects) => {
    return workers.createWorker(task, { objects, installDir }, async props => {
        const path = require('path');
        const fs = require('fs-extra');
        const files = require('../util/files');
        const lock = require('../util/lockfile');

        const keys = Object.keys(props.objects);
        const objectDir = path.join(props.installDir, 'assets', 'objects');
        const lockfile = path.join(objectDir, 'assets-lock');
        let complete = 0, total = keys.length;

        if (await lock.check(lockfile))
            return props.complete();
        // Lock this directory so others will skip it, however expire it in 10 minutes in case anything goes wrong and it does not get expired.
        await lock.lock(lockfile, { stale: 600000 });

        for (let i = 0; i < keys.length; i++) {
            const object = props.objects[keys[i]];
            try {
                console.log(`Processing ${keys[i]}`);
                const file = path.join(objectDir, object.hash.substring(0, 2), object.hash.substring(2));
                if (!(await fs.pathExists(file) && (await files.fileChecksum(file, 'sha1')) === object.hash)) {
                    console.log(`Downloading ${keys[i]}`);
                    await files.download(`https://resources.download.minecraft.net/${object.hash.substring(0, 2)}/${object.hash}`, file);
                } else console.log(`Found valid version of ${keys[i]} with matching checksum.`);
                props.updateTask('validating game assets', ++complete/total);
            } catch (e) {
                props.error(e);
            }
        }
        lock.unlock(lockfile);

        props.complete();
    });
};

const validateTypeOneLibraries = (task, taskName, libraries) => {
    return workers.createWorker(task, { libraries, taskName, libDir }, async props => {
        const path = require('path');
        const fs = require('fs-extra');
        const files = require('../util/files');
        const lock = require('../util/lockfile');

        const osName = {
            win32: 'windows',
            darwin: 'osx',
            linux: 'linux',
            sunos: 'linux',
            openbsd: 'linux',
            android: 'linux',
            aix: 'linux',
        }[process.platform];

        // Completion Callback
        let complete = 0, total = props.libraries.length;
        const callback = () => {
            props.updateTask(props.taskName, ++complete/total);
            if (complete === total)
                props.complete();
        };

        const task = library => new Promise(async resolve => {
            console.log(`Validating ${library.name}`);

            if (!library.downloads)
                return resolve();

            // Forge universal has an empty url.
            if (library.name.startsWith('net.minecraftforge:forge:') && library.name.endsWith(':universal'))
                library.downloads.artifact.url = `https://files.minecraftforge.net/maven/${library.downloads.artifact.path}`;
            // The hosted version of log4j is corrupt.
            if (library.name.startsWith('org.apache.logging.log4j:log4j-api:') || library.name.startsWith('org.apache.logging.log4j:log4j-core:'))
                library.downloads.artifact.url = `http://central.maven.org/maven2/${library.downloads.artifact.path}`;

            let valid = true;
            if (library.rules) {
                for (let i = 0; i < library.rules.length; i++) {
                    if (library.rules[i].os === undefined)
                        continue;
                    if ((library.rules[i].os.name !== osName && library.rules[i].action === 'allow') || library.rules[i].os.name === osName && library.rules[i].action === 'deny')
                        valid = false;
                }
            }

            if (valid && library.downloads.artifact) {
                const filePath = path.join(props.libDir, library.downloads.artifact.path);
                const lockfile = path.join(path.dirname(filePath), 'library-lock');
                if (!await lock.check(lockfile)) {
                    await lock.lock(lockfile, { stale: 60000 });

                    if (!await fs.pathExists(filePath) || (await files.fileChecksum(filePath, 'sha1')) !== library.downloads.artifact.sha1) {
                        console.log(`Unable to locate ${library.name}, it will be downloaded.`);
                        await files.download(library.downloads.artifact.url, filePath);
                        await lock.unlock(lockfile)
                    } else
                        console.log(`Found ${library.name}.`);
                }
            }

            if (!library.natives)
                return resolve();
            console.log(`${library.name} has a native file.`);
            const native = library.natives[osName];
            if (native === undefined)
                return resolve();

            const nativePath = path.join(props.libDir, library.downloads.classifiers[native].path);
            const lockfile = path.join(path.dirname(nativePath), 'library-lock');
            // if (await lock.check(lockfile))
            //     return props.complete();
            // await lock.lock(lockfile, { stale: 60000 });

            if (!await fs.pathExists(nativePath) || (await files.fileChecksum(nativePath, 'sha1')) !== library.downloads.classifiers[native].sha1) {
                console.log(`Unable to locate native for ${library.name}, it will be downloaded.`);
                await files.download(library.downloads.classifiers[native].url, nativePath);
                // await lock.unlock(lockfile);
            } else
                console.log(`Found native for ${library.name}.`);

            resolve();
        });

        if (props.isParallel)
            props.libraries.forEach(library => task(library).catch(props.error).finally(callback));
        else
            for (let i = 0; i < props.libraries.length; i++)
                await task(props.libraries[i]).catch(props.error).finally(callback);
    });
};

const validateTypeTwoLibraries = (task, taskName, libraries) => {
    return workers.createWorker(task, { libraries, taskName, libDir }, async props => {
        const path = require('path');
        const fs = require('fs-extra');
        const files = require('../util/files');
        const lock = require('../util/lockfile');

        let complete = 0, total = props.libraries.length;
        const callback = () => {
            props.updateTask(props.taskName, ++complete/total);
            if (complete === total)
                props.complete();
        };

        const task = library => new Promise(async resolve => {
            console.log(`Validating ${library.name}`);
            if (library.clientreq === false)
                return resolve();

            const baseUrl = library.url === undefined ? 'https://repo1.maven.org/maven2/' : library.url;
            const name = library.name.split(':');
            const url = `${baseUrl}${name[0].split('.').join('/')}/${name[1]}/${name[2]}/${name[1]}-${name[2]}.jar`;
            const filePath = path.join(props.libDir, name[0].split('.').join('/'), name[1], name[2], `${name[1]}-${name[2]}.jar`);

            const lockfile = path.join(path.dirname(filePath), 'library-lock');
            if (await lock.check(lockfile))
                return props.complete();
            await lock.lock(lockfile, { stale: 60000 });

            if (!await fs.pathExists(filePath)) {
                console.log(`Unable to locate ${library.name}, it will be downloaded.`);
                await files.download(url, filePath);
                await lock.unlock(lockfile)
            } else
                console.log(`Found ${library.name}.`);
            resolve();
        });

        if (props.isParallel)
            props.libraries.forEach(async library => task(library).catch(props.error).finally(callback));
        else for (let i = 0; i < props.libraries.length; i++)
            await task(props.libraries[i]).catch(props.error).finally(callback);
    });
};

const runForgeProcessors = (task, processors, vars, mcVersion, forgeVersion) => {
    return workers.createWorker(task, { processors, vars, mcVersion, forgeVersion, installDir, libDir }, async props => {
        const path = require('path');
        const fs = require('fs-extra');
        const lock = require('../util/lockfile');
        const artifact = require('../util/artifact');

        // Start helper functions
        const exec = cmd => new Promise((resolve, reject) => {
            require('child_process').exec(cmd, {maxBuffer: 1024 * 1024}, (err, stdout, stderr) => {
                if (err) reject(err);
                resolve({
                    stdout: stdout.split(require('os').EOL),
                    stderr: stderr.split(require('os').EOL)
                });
            });
        });
        // End helper functions

        // These are used later, but needed for the completion callback
        const clientDataPathSource = path.join(props.libDir, 'net', 'minecraftforge', 'forge', `${props.mcVersion}-${props.forgeVersion}`, `forge-${props.mcVersion}-${props.forgeVersion}-clientdata.lzma`);
        const clientDataPathTarget = path.join(props.installDir, '../', 'temp', 'data', 'client.lzma');

        // Locking
        const lockfile = path.join(props.installDir, 'forge-installer-lock');
        if (await lock.check(lockfile))
            return props.complete();
        await lock.lock(lockfile, { stale: 600000 });

        // Completion Callback
        let complete = -1, total = props.processors.length;
        const callback = async () => {
            props.updateTask('installing forge', ++complete/total);
            if (complete === total) {
                props.complete();
                await fs.remove(clientDataPathTarget);
                await lock.unlock(lockfile);
            }
        };
        await callback();

        // Generate Environment Variables
        let envars = {};
        const keys = Object.keys(props.vars);
        keys.forEach(key => {
            let val = props.vars[key].client;
            if (val.startsWith('/'))
                val = path.join(props.installDir, '../', 'temp', val);
            if (val.startsWith('['))
                val = path.join(props.libDir, artifact.findLibraryPath(val.substring(1, val.length - 1)));
            envars[key] = `"${val}"`;
        });
        envars.MINECRAFT_JAR = `"${path.join(props.installDir, 'versions', props.mcVersion, `${props.mcVersion}.jar`)}"`;

        console.log('Starting forge installer...');
        console.log('Using variables: ', envars);

        // Move files around
        await fs.copy(clientDataPathSource, clientDataPathTarget);
        await fs.remove(clientDataPathSource);

        const task = processor => new Promise(async resolve => {
            const processorJar = path.join(props.libDir, artifact.findLibraryPath(processor.jar));

            let arguments = ['-cp', `"${processorJar};${processor.classpath.map(cp => path.join(props.libDir, artifact.findLibraryPath(cp))).join(';')}"`, await artifact.findMainClass(processorJar)];
            const envarKeys = Object.keys(envars);
            arguments = arguments.concat(processor.args.map(arg => {
                for (let j = 0; j < envarKeys.length; j++)
                    if (arg.startsWith(`{${envarKeys[j]}}`))
                        return envars[envarKeys[j]];
                if (arg.startsWith('['))
                    return `"${path.join(props.libDir, artifact.findLibraryPath(arg))}"`;
                return arg;
            }));

            console.log(`Starting ${arguments[2]}.`);
            const resp = await exec(`java ${arguments.join(' ')}`);
            console.log(resp);

            resolve();
        });

        if (props.isParallel)
            props.processors.forEach(async processor => task(processor).catch(props.error).finally(callback));
        else
            for (let i = 0; i < props.processors.length; i++)
                await task(props.processors[i]).catch(props.error).finally(callback);
    });
};

const curseCopyOverrides = (task, profileDir, overrideDir, overrides) => {
    return workers.createWorker(task, { profileDir, overrideDir, overrides }, async props => {
        const path = require('path');
        const fs = require('fs-extra');
        const lock = require('../util/lockfile');

        // Directory Lock
        const lockfile = path.join(props.profileDir, 'override-lock');
        if (await lock.check(lockfile))
            return props.complete();
        await lock.lock(lockfile, { stale: 60000 });

        // Completion Callback
        let complete = 0, total = props.overrides.length;
        const callback = async () => {
            props.updateTask('copying overrides', ++complete/total);
            if (complete === total) {
                props.complete();
                await lock.unlock(lockfile);
            }
        };

        const task = override => fs.copy(path.join(props.overrideDir, override), path.join(props.profileDir, override));

        if (props.isParallel)
            props.overrides.forEach(override => task(override).catch(props.error).finally(callback));
        else
            for (let i = 0; i < props.overrides.length; i++)
                await task(props.overrides[i]).catch(props.error).finally(callback);
    });
};

const curseInstallMods = (task, profileDir, mods) => {
    return workers.createWorker(task, { profileDir, mods }, async props => {
        const path = require('path');
        const fs = require('fs-extra');
        const files = require('../util/files');
        const lock = require('../util/lockfile');

        const modsDir = path.join(props.profileDir, 'mods');
        await fs.mkdirs(modsDir);

        // Directory locking
        const lockfile = path.join(modsDir, 'mods-lock');
        if (await lock.check(lockfile))
            return props.complete();
        await lock.lock(lockfile, { stale: 600000 });

        // Completion Callback
        let complete = 0, total = props.mods.length;
        const callback = async name => {
            props.updateTask(`downloading ${name}`, ++complete/total);
            if (complete === total) {
                props.complete();
                await lock.unlock(lockfile)
            }
        };

        const task = mod => new Promise(async resolve => {
            const name = (await (await fetch(`https://addons-ecs.forgesvc.net/api/v2/addon/${mod.projectID}`)).json()).name;
            const fileJson = await (await fetch(`https://addons-ecs.forgesvc.net/api/v2/addon/${mod.projectID}/file/${mod.fileID}`)).json();
            await files.download(fileJson.downloadUrl, path.join(modsDir, fileJson.fileName));
            resolve(name);
        });

        if (props.isParallel)
            props.mods.forEach(mod => task(mod).then(callback).catch(props.error));
        else
            for (let i = 0; i < props.mods.length; i++)
                await task(props.mods[i]).then(callback).catch(props.error);
    });
};
