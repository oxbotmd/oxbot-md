const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
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

// Update via Git
async function updateViaGit() {
    const oldRev = (await run('git rev-parse HEAD').catch(() => 'unknown')).trim();
    await run('git fetch --all --prune');
    const newRev = (await run('git rev-parse origin/main')).trim();
    const alreadyUpToDate = oldRev === newRev;
    if (!alreadyUpToDate) {
        await run(`git reset --hard ${newRev}`);
        await run('git clean -fd');
    }
    return { oldRev, newRev, alreadyUpToDate };
}

/**
 * Update via Raw GitHub File
 * Bypasses the need for unzip tools by downloading files directly.
 */
async function updateViaRaw() {
    const repoUrl = settings.repoUrl || "https://github.com/oxbotmd/oxbot-md";
    // Convert GitHub URL to Raw URL
    let rawBaseUrl = repoUrl
        .replace('github.com', 'raw.githubusercontent.com')
        .replace(/\/$/, ''); 

    const branch = "main"; 
    const targetFile = "index.js"; 
    const fileUrl = `${rawBaseUrl}/${branch}/${targetFile}`;
    const destPath = path.join(process.cwd(), targetFile);

    console.log(`[Updater] Downloading ${targetFile} from ${fileUrl}`);

    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    
    if (response.status !== 200) {
        throw new Error(`Failed to download file: HTTP ${response.status}`);
    }

    // Backup existing file
    if (fs.existsSync(destPath)) {
        const backupPath = destPath + '.backup';
        fs.copyFileSync(destPath, backupPath);
    }

    fs.writeFileSync(destPath, response.data);
    
    return { updatedFile: targetFile };
}

// Restart logic
async function restartProcess(sock, chatId, message) {
    try {
        await sock.sendMessage(chatId, { text: '✅ Update complete! Restarting bot…' }, { quoted: message });
    } catch {}
    
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
        await sock.sendMessage(chatId, { text: '🔄 *OxBot MD Update Started*' }, { quoted: message });

        if (await hasGitRepo()) {
            const { alreadyUpToDate, newRev } = await updateViaGit();
            if (alreadyUpToDate) {
                await sock.sendMessage(chatId, { text: `✅ Already up to date.\nCurrent: ${newRev.substring(0, 7)}` }, { quoted: message });
                return;
            }
            await sock.sendMessage(chatId, { text: `✅ Updated via Git! Restarting...` }, { quoted: message });
            await restartProcess(sock, chatId, message);
        } else {
            // Use Raw File method because unzip is missing
            await sock.sendMessage(chatId, { text: '📥 No Git/Unzip found. Using Raw File Update method...' }, { quoted: message });
            
            const { updatedFile } = await updateViaRaw();
            
            await sock.sendMessage(chatId, { 
                text: `✅ Successfully updated \`${updatedFile}\` from GitHub!\n\nRestarting to apply changes...` 
            }, { quoted: message });
            
            await restartProcess(sock, chatId, message);
        }

    } catch (err) {
        console.error('Update failed:', err);
        await sock.sendMessage(chatId, { 
            text: `❌ *Update Failed!*\n\n${String(err.message || err)}` 
        }, { quoted: message });
    }
}

module.exports = updateCommand;
