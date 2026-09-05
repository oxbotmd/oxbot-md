const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const settings = require('../settings');
const isOwnerOrSudo = require('../lib/isOwner');

// Helper to run shell commands
function run(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || stdout || err.message || '').toString()));
            resolve((stdout || '').toString());
        });
    });
}

// Check if git is available
async function hasGitRepo() {
    const gitDir = path.join(process.cwd(), '.git');
    if (!fs.existsSync(gitDir)) return false;
    try {
        await run('git --version');
        return true;
    } catch {
        return false;
    }
}

// Update via Git (Preferred if .git exists)
async function updateViaGit() {
    const oldRev = (await run('git rev-parse HEAD').catch(() => 'unknown')).trim();
    await run('git fetch --all --prune');
    const newRev = (await run('git rev-parse origin/main')).trim();
    const alreadyUpToDate = oldRev === newRev;
    const commits = alreadyUpToDate ? '' : await run(`git log --pretty=format:"%h %s (%an)" ${oldRev}..${newRev}`).catch(() => '');
    const files = alreadyUpToDate ? '' : await run(`git diff --name-status ${oldRev} ${newRev}`).catch(() => '');
    await run(`git reset --hard ${newRev}`);
    await run('git clean -fd');
    return { oldRev, newRev, alreadyUpToDate, commits, files };
}

// Download file with redirect support
function downloadFile(url, dest, visited = new Set()) {
    return new Promise((resolve, reject) => {
        try {
            // Avoid infinite redirect loops
            if (visited.has(url) || visited.size > 5) {
                return reject(new Error('Too many redirects'));
            }
            visited.add(url);

            const useHttps = url.startsWith('https://');
            const client = useHttps ? require('https') : require('http');
            const req = client.get(url, {
                headers: {
                    'User-Agent': 'OxBot-Updater/1.0',
                    'Accept': '*/*'
                }
            }, res => {
                // Handle redirects
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    const location = res.headers.location;
                    if (!location) return reject(new Error(`HTTP ${res.statusCode} without Location`));
                    const nextUrl = new URL(location, url).toString();
                    res.resume();
                    return downloadFile(nextUrl, dest, visited).then(resolve).catch(reject);
                }

                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }

                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
                file.on('error', err => {
                    try { file.close(() => {}); } catch {}
                    fs.unlink(dest, () => reject(err));
                });
            });
            req.on('error', err => {
                fs.unlink(dest, () => reject(err));
            });
        } catch (e) {
            reject(e);
        }
    });
}

// Extract ZIP using system tools
async function extractZip(zipPath, outDir) {
    if (process.platform === 'win32') {
        const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir.replace(/\\/g, '/')}' -Force"`;
        await run(cmd);
        return;
    }
    // Linux/mac: try unzip, else 7z, else busybox unzip
    try {
        await run('command -v unzip');
        await run(`unzip -o '${zipPath}' -d '${outDir}'`);
        return;
    } catch {}
    try {
        await run('command -v 7z');
        await run(`7z x -y '${zipPath}' -o'${outDir}'`);
        return;
    } catch {}
    try {
        await run('busybox unzip -h');
        await run(`busybox unzip -o '${zipPath}' -d '${outDir}'`);
        return;
    } catch {}
    throw new Error("No system unzip tool found (unzip/7z/busybox). Cannot perform update.");
}

// Recursive copy with ignore list
function copyRecursive(src, dest, ignore = [], relative = '', outList = []) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
        if (ignore.includes(entry)) continue;
        const s = path.join(src, entry);
        const d = path.join(dest, entry);
        const stat = fs.lstatSync(s);
        if (stat.isDirectory()) {
            copyRecursive(s, d, ignore, path.join(relative, entry), outList);
        } else {
            fs.copyFileSync(s, d);
            if (outList) outList.push(path.join(relative, entry).replace(/\\/g, '/'));
        }
    }
}

// Main ZIP update logic
async function updateViaZip(sock, chatId, message, zipOverride) {
    // Use the URL from settings.js or the override
    const zipUrl = (zipOverride || settings.updateZipUrl || process.env.UPDATE_ZIP_URL || '').trim();
    
    if (!zipUrl) {
        throw new Error('No ZIP URL configured. Set settings.updateZipUrl.');
    }

    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, 'update.zip');
    
    // Download
    await downloadFile(zipUrl, zipPath);
    
    // Extract
    const extractTo = path.join(tmpDir, 'update_extract');
    if (fs.existsSync(extractTo)) fs.rmSync(extractTo, { recursive: true, force: true });
    await extractZip(zipPath, extractTo);

    // Handle GitHub zip structure (repo-branch folder)
    const [root] = fs.readdirSync(extractTo).map(n => path.join(extractTo, n));
    const srcRoot = fs.existsSync(root) && fs.lstatSync(root).isDirectory() ? root : extractTo;

    // Dirs/files to preserve (ignore during overwrite)
    const ignore = ['node_modules', '.git', 'session', 'tmp', 'tmp/', 'temp', 'data', 'baileys_store.json', 'owner.json'];
    
    // Preserve owner settings from current settings.js
    let preservedOwner = null;
    let preservedBotOwner = null;
    try {
        // We load settings fresh to be sure
        const currentSettings = require('../settings');
        preservedOwner = currentSettings && currentSettings.ownerNumber ? String(currentSettings.ownerNumber) : null;
        preservedBotOwner = currentSettings && currentSettings.botOwner ? String(currentSettings.botOwner) : null;
    } catch (e) {
        console.error('Error reading settings for preservation:', e);
    }

    const copied = [];
    copyRecursive(srcRoot, process.cwd(), ignore, '', copied);

    // Restore owner settings in the new settings.js
    if (preservedOwner || preservedBotOwner) {
        try {
            const settingsPath = path.join(process.cwd(), 'settings.js');
            if (fs.existsSync(settingsPath)) {
                let text = fs.readFileSync(settingsPath, 'utf8');
                
                if (preservedOwner) {
                    // Regex to match ownerNumber: '...'
                    text = text.replace(/ownerNumber:\s*'[^']*'/, `ownerNumber: '${preservedOwner}'`);
                }
                if (preservedBotOwner) {
                    // Regex to match botOwner: '...'
                    text = text.replace(/botOwner:\s*'[^']*'/, `botOwner: '${preservedBotOwner}'`);
                }
                
                fs.writeFileSync(settingsPath, text);
            }
        } catch (e) {
            console.error('Error restoring settings:', e);
        }
    }

    // Cleanup
    try { fs.rmSync(extractTo, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(zipPath, { force: true }); } catch {}
    
    return { copiedFiles: copied };
}

// Restart logic
async function restartProcess(sock, chatId, message) {
    try {
        await sock.sendMessage(chatId, { text: '✅ Update complete! Restarting bot…' }, { quoted: message });
    } catch {}
    
    try {
        // Try PM2 first (common on VPS/Node panels)
        await run('pm2 restart oxbot || pm2 restart all');
        return;
    } catch {}
    
    // Fallback: process exit (panel managers like Pterodactyl will auto-restart)
    setTimeout(() => {
        process.exit(0);
    }, 1000);
}

// Command Handler
async function updateCommand(sock, chatId, message, zipOverride) {
    const senderId = message.key.participant || message.key.remoteJid;
    const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
    
    if (!message.key.fromMe && !isOwner) {
        await sock.sendMessage(chatId, { text: '⚠️ Only the bot owner can use this command.' }, { quoted: message });
        return;
    }

    try {
        await sock.sendMessage(chatId, { text: '🔄 *OxBot MD Update Started*\n\nFetching latest files from GitHub...', { quoted: message });

        if (await hasGitRepo()) {
            // Prefer Git if repo exists
            const { oldRev, newRev, alreadyUpToDate, commits } = await updateViaGit();
            if (alreadyUpToDate) {
                await sock.sendMessage(chatId, { text: `✅ Already up to date.\n\nCurrent Version: ${newRev.substring(0, 7)}` }, { quoted: message });
                return;
            }
            await sock.sendMessage(chatId, { text: `✅ Updated via Git!\nNew Version: ${newRev.substring(0, 7)}\nInstalling dependencies...` }, { quoted: message });
            await run('npm install --no-audit --no-fund');
        } else {
            // Fallback to ZIP method (matches your settings.js url)
            const { copiedFiles } = await updateViaZip(sock, chatId, message, zipOverride);
            await sock.sendMessage(chatId, { text: `✅ Files updated successfully!\nModified files: ${copiedFiles.length}` }, { quoted: message });
        }

        // Restart
        await restartProcess(sock, chatId, message);

    } catch (err) {
        console.error('Update failed:', err);
        await sock.sendMessage(chatId, { 
            text: `❌ *Update Failed!*\n\n${String(err.message || err)}` 
        }, { quoted: message });
    }
}

module.exports = updateCommand;
