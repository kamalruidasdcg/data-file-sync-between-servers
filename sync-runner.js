const { NodeSSH } = require("node-ssh");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const ssh = new NodeSSH();

// ==========================================
// 1. COMMAND LINE ARGUMENT PARSING
// ==========================================
const getArg = (name) => {
    const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.split("=")[1] : null;
};

const action = getArg("action"); // 'download' or 'upload'
const serverName = getArg("server"); // 'NIC' or 'LAN'
const targetDate = getArg("date"); // e.g., '20260311'
const sourceFolder = getArg("source"); // Only needed for upload (where to read from)

if (!action || !["download", "upload"].includes(action.toLowerCase())) {
    console.error("❌ Error: --action must be 'download' or 'upload'");
    console.log("FOR UPLOAD: node sync-runner.js --action=upload --source=LAN --server=LAN --date=20260312");
    console.log("FOR DOWNLOAD: node sync-runner.js --action=download --server=NIC --date=20260312");
    process.exit(1);
}
if (!serverName || !["NIC", "LAN"].includes(serverName.toUpperCase())) {
    console.error("❌ Error: --server must be 'NIC' or 'LAN'");
    console.log("FOR UPLOAD: node sync-runner.js --action=upload --source=LAN --server=NIC --date=20260312");
    console.log("FOR DOWNLOAD: node sync-runner.js --action=download --server=NIC --date=20260312");
    process.exit(1);
}
if (!targetDate || targetDate.length !== 8) {
    console.error("❌ Error: --date must be YYYYMMDD format. (e.g., 20260311)");
    process.exit(1);
}

// ==========================================
// 2. DATE FORMATTERS
// ==========================================
const yyyy = targetDate.substring(0, 4);
const mm = targetDate.substring(4, 6);
const dd = targetDate.substring(6, 8);

const FORMAT_DD_MM_YYYY = `${dd}-${mm}-${yyyy}`; // "11-03-2026"
const FORMAT_YYYY_MM_DD = `${yyyy}-${mm}-${dd}`; // "2026-03-11"
const FORMAT_YYYYMMDD = targetDate; // "20260311"
const FORMAT_YYYYMM = `${yyyy}${mm}`; // "202603"

const PARENT_PATH = "/var/www/html/obps/backend_obps";

// ==========================================
// 3. SERVER CONFIGURATIONS
// ==========================================
const SERVERS = {
    NIC: {
        name: "NIC",
        host: "10.212.122.153",
        port: 22,
        username: "",
        password: "", // <-- Make sure to put your password here for sudo -S to work
        apiUrl: "https://obps.grse.in/api/v1/sync/sync_unzip",
    },
    LAN: {
        name: "LAN",
        host: "10.18.7.123",
        port: 22,
        username: "",
        password: "",
        apiUrl: "http://10.18.1.242:4001/api/v1/sync/sync_unzip",
    },
};

const activeConfig = SERVERS[serverName.toUpperCase()];

const ensureLocalDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

// ==========================================
// AUTO-PERMISSION FIXER (NIC SERVER)
// ==========================================
const fixNicPermissions = async (config) => {
    console.log("\n-> Elevating permissions (chmod 777) on NIC folders...");

    // Use sudo -S to pass the password programmatically to avoid interactive prompts
    const sudoPrefix = config.password ? `echo ${config.password} | sudo -S ` : `sudo `;

    const dirsToFix = [
        `${PARENT_PATH}/sync`,
        `${PARENT_PATH}/uploads/compliances`,
        `${PARENT_PATH}/uploads/po`,
        `${PARENT_PATH}/uploads/paymentadvice`,
        `${PARENT_PATH}/uploads/icgrnremarks/${FORMAT_YYYYMMDD}`,
        `${PARENT_PATH}/uploads/${FORMAT_YYYYMMDD}`
    ];

    for (const dir of dirsToFix) {
        // Ensure the directory exists first so chmod doesn't throw an error
        await ssh.execCommand(`${sudoPrefix} mkdir -p ${dir}`);
        await ssh.execCommand(`${sudoPrefix} chmod 777 -R ${dir}`);
    }
    console.log("   ✅ Permissions successfully updated.");
};


// ==========================================
// GENERIC DOWNLOAD LOGIC
// ==========================================
const performDownload = async (config) => {
    const isLAN = config.name === "LAN";
    const isNIC = config.name === "NIC";

    const localWorkspace = path.join(__dirname, "SYNC_WORKSPACE", `DOWNLOADED_FROM_${config.name}_${FORMAT_YYYYMMDD}`);
    console.log(`\n🚀 [DOWNLOAD MODE] Pulling data from ${config.name} for ${FORMAT_YYYYMMDD}...`);
    ensureLocalDir(localWorkspace);

    await ssh.connect(config);
    console.log(`✅ Connected to ${config.name} Server.`);

    try {
        // Automatically fix permissions if we are on the NIC server
        if (isNIC) {
            await fixNicPermissions(config);
        }

        // 1. Sync Zip (BOTH SERVERS)
        console.log("\n-> Downloading Database Sync Zip...");
        try {
            const zipFileName = `${FORMAT_YYYYMMDD}-${serverName}-sync_data.zip`;
            console.log("zipFileName", zipFileName);
            await ssh.getFile(path.join(localWorkspace, zipFileName), `${PARENT_PATH}/sync/zipData/${FORMAT_YYYYMMDD}/${zipFileName}`);
            console.log("   ✅ Success");
        } catch (e) {
            console.log("   ⚠️ Not found on server. Skipping...");
        }

        // 2. PO Tar (LAN SERVER ONLY)
        if (isLAN) {
            console.log("\n-> Taring and Downloading POs...");
            const tarName = `${FORMAT_YYYYMMDD}po.tar`;
            try {
                const checkPoRes = await ssh.execCommand(`ls *_${FORMAT_YYYYMMDD}_*`, { cwd: `${PARENT_PATH}/uploads/po` });
                if (checkPoRes.stdout) {
                    await ssh.execCommand(`tar -cvf ${tarName} *_${FORMAT_YYYYMMDD}_*`, { cwd: `${PARENT_PATH}/uploads/po` });
                    await ssh.getFile(path.join(localWorkspace, tarName), `${PARENT_PATH}/uploads/po/${tarName}`);
                    await ssh.execCommand(`rm ${tarName}`, { cwd: `${PARENT_PATH}/uploads/po` });
                    console.log("   ✅ Success");
                } else {
                    console.log("   ⚠️ No PO files found for this date. Skipping...");
                }
            } catch (e) {
                console.log("   ⚠️ Error processing POs. Skipping...");
            }
        }

        // 3. General Uploads (BOTH SERVERS)
        console.log("\n-> Downloading General Uploads...");
        const uploadsLocal = path.join(localWorkspace, "uploads", FORMAT_YYYYMMDD);
        try {
            ensureLocalDir(uploadsLocal);
            await ssh.getDirectory(uploadsLocal, `${PARENT_PATH}/uploads/${FORMAT_YYYYMMDD}`);
            console.log("   ✅ Success");
        } catch (e) {
            console.log("   ⚠️ Folder not found on server. Skipping...");
        }

        // 4. Compliances (NIC SERVER ONLY)
        if (isNIC) {
            console.log("\n-> Downloading Compliances...");
            const compLocal = path.join(localWorkspace, "compliances");
            try {
                ensureLocalDir(compLocal);
                await ssh.getDirectory(compLocal, `${PARENT_PATH}/uploads/compliances/${FORMAT_YYYYMM}/${dd}`);
                console.log("   ✅ Sync data zip download successfully");
            } catch (e) {
                console.log("   ⚠️ Folder not found on server. Skipping...");
            }
        }

        // 5. Payment Advice (LAN SERVER ONLY)
        if (isLAN) {
            console.log(`\n-> Scanning for Payment Advice folders modified on ${FORMAT_YYYY_MM_DD}...`);
            const payLocalBase = path.join(localWorkspace, "paymentadvice");
            ensureLocalDir(payLocalBase);

            try {
                const findCmd = `find . -mindepth 1 -maxdepth 1 -type d -newermt "${FORMAT_YYYY_MM_DD} 00:00:00" ! -newermt "${FORMAT_YYYY_MM_DD} 23:59:59" -exec basename {} \\;`;
                const checkFoldersRes = await ssh.execCommand(findCmd, { cwd: `${PARENT_PATH}/uploads/paymentadvice` });

                if (checkFoldersRes.stdout) {
                    const folders = checkFoldersRes.stdout.split('\n').map(f => f.trim()).filter(f => f);

                    if (folders.length > 0) {
                        console.log(`   Found ${folders.length} modified folder(s): ${folders.join(', ')}`);
                        for (const folder of folders) {
                            console.log(`   -> Downloading folder: ${folder}...`);
                            const localFolderDir = path.join(payLocalBase, folder);
                            ensureLocalDir(localFolderDir);
                            await ssh.getDirectory(localFolderDir, `${PARENT_PATH}/uploads/paymentadvice/${folder}`);
                        }
                        console.log("   ✅ All modified Payment Advice folders downloaded successfully.");
                    } else {
                        console.log("   ⚠️ No folders modified on this date. Skipping...");
                    }
                } else {
                    console.log("   ⚠️ No folders modified on this date. Skipping...");
                }
            } catch (e) {
                console.log(`   ⚠️ Error processing Payment Advice: ${e.message}`);
            }
        }

        // 6. ICGRN remarks (LAN SERVER ONLY)
        if (isLAN) {
            console.log("\n-> Downloading ICGRN remarks Uploads...");
            const uploadsLocal = path.join(localWorkspace, "icgrnremarks", FORMAT_YYYYMMDD);
            try {
                ensureLocalDir(uploadsLocal);
                await ssh.getDirectory(uploadsLocal, `${PARENT_PATH}/uploads/icgrnremarks/${FORMAT_YYYYMMDD}`);
                console.log("   ✅ ICGRN Remarks Success");
            } catch (e) {
                console.log("   ⚠️ icgrnremarks folder not found on server. Skipping...");
            }
        }

        console.log(`\n🎉 ${config.name} DOWNLOADS COMPLETE! Data saved to: SYNC_WORKSPACE/DOWNLOADED_FROM_${config.name}_${FORMAT_YYYYMMDD}`);
    } finally {
        ssh.dispose();
    }
};

// ==========================================
// GENERIC UPLOAD LOGIC
// ==========================================
const performUpload = async (config, sourceName) => {
    if (!sourceName || !["NIC", "LAN"].includes(sourceName.toUpperCase())) {
        console.error("❌ Error: When uploading, you must specify --source=NIC or --source=LAN");
        process.exit(1);
    }

    const isLAN = config.name === "LAN";
    const isNIC = config.name === "NIC";

    const localWorkspace = path.join(__dirname, "SYNC_WORKSPACE", `DOWNLOADED_FROM_${sourceName.toUpperCase()}_${FORMAT_YYYYMMDD}`);
    console.log("localWorkspace", localWorkspace);

    console.log(`\n🚀 [UPLOAD MODE] Pushing data from ${sourceName} to ${config.name} for ${FORMAT_YYYYMMDD}...`);

    if (!fs.existsSync(localWorkspace)) {
        console.error(`❌ Error: Local folder ${localWorkspace} does not exist. Run the download step first!`);
        process.exit(1);
    }

    await ssh.connect(config);
    console.log(`✅ Connected to ${config.name} Server.`);

    try {
        // Automatically fix permissions if we are on the NIC server
        if (isNIC) {
            await fixNicPermissions(config);
        }

        // 1. Database Sync Zip (BOTH SERVERS)
        const zipFileName = `${FORMAT_YYYYMMDD}-${sourceName}-sync_data.zip`;
        console.log("zipFileName", zipFileName);

        const localSyncZip = path.join(localWorkspace, zipFileName);
        if (fs.existsSync(localSyncZip)) {
            console.log("\n-> Uploading Database Sync Zip...");
            const remoteZipDir = `${PARENT_PATH}/sync/otherServerData/Data/${FORMAT_YYYYMMDD}`;
            await ssh.execCommand(`mkdir -p ${remoteZipDir}`);
            await ssh.putFile(localSyncZip, `${remoteZipDir}/${zipFileName}`);
            console.log("   ✅ Success");

            console.log(`-> Triggering ${config.name} Database Ingestion API...`);
            try {
                const response = await axios.post(config.apiUrl, { from_date: FORMAT_YYYY_MM_DD });
                console.log(`   ✅ API Success: `, response.data);
            } catch (apiErr) {
                console.error(`   ⚠️ API Error: ${apiErr.message}`);
            }
        } else {
            console.log("\n⚠️ sync_data.zip not found locally. Skipping upload & API trigger...");
        }

        // 2. Upload and Untar POs (NIC SERVER ONLY)
        if (isNIC) {
            const localTarPath = path.join(localWorkspace, `${FORMAT_YYYYMMDD}po.tar`);
            if (fs.existsSync(localTarPath)) {
                console.log("\n-> Uploading and Extracting POs...");
                const remotePoDir = `${PARENT_PATH}/uploads/po`;
                const tarName = `${FORMAT_YYYYMMDD}po.tar`;

                await ssh.putFile(localTarPath, `${remotePoDir}/${tarName}`);
                await ssh.execCommand(`tar -xvf ${tarName}`, { cwd: remotePoDir });
                await ssh.execCommand(`rm ${tarName}`, { cwd: remotePoDir });
                console.log("   ✅ Success");
            } else {
                console.log("\n⚠️ PO Tar not found locally. Skipping...");
            }
        }

        // 3. General Uploads (BOTH SERVERS)
        const localUploadsDir = path.join(localWorkspace, "uploads", FORMAT_YYYYMMDD);
        if (fs.existsSync(localUploadsDir) && fs.readdirSync(localUploadsDir).length > 0) {
            console.log("\n-> Uploading General Uploads...");
            const remoteUploadsDir = `${PARENT_PATH}/uploads/${FORMAT_YYYYMMDD}`;
            await ssh.execCommand(`mkdir -p ${remoteUploadsDir}`);
            await ssh.putDirectory(localUploadsDir, remoteUploadsDir);
            console.log("   ✅ Success");
        } else {
            console.log("\n⚠️ General uploads folder empty or missing locally. Skipping...");
        }

        // 4. Compliances (LAN SERVER ONLY)
        if (isLAN) {
            const localCompDir = path.join(localWorkspace, "compliances", FORMAT_YYYYMM, dd);
            if (fs.existsSync(localCompDir) && fs.readdirSync(localCompDir).length > 0) {
                console.log("\n-> Uploading Compliances...");
                const compRemoteDir = `${PARENT_PATH}/uploads/compliances/${FORMAT_YYYYMM}/${dd}`;
                await ssh.execCommand(`mkdir -p ${compRemoteDir}`);
                await ssh.putDirectory(localCompDir, compRemoteDir);
                console.log("   ✅ Success");
            } else {
                console.log("\n⚠️ Compliances folder empty or missing locally. Skipping...");
            }
        }

        // 5. Payment Advice (NIC SERVER ONLY)
        if (isNIC) {
            const localPayBaseDir = path.join(localWorkspace, "paymentadvice");
            if (fs.existsSync(localPayBaseDir)) {
                const foldersToUpload = fs.readdirSync(localPayBaseDir)
                    .filter(f => fs.lstatSync(path.join(localPayBaseDir, f)).isDirectory());

                if (foldersToUpload.length > 0) {
                    console.log(`\n-> Uploading ${foldersToUpload.length} Payment Advice folder(s)...`);
                    for (const folder of foldersToUpload) {
                        console.log(`   -> Uploading folder: ${folder}...`);
                        const payRemoteDir = `${PARENT_PATH}/uploads/paymentadvice/${folder}`;
                        await ssh.execCommand(`mkdir -p ${payRemoteDir}`);
                        await ssh.putDirectory(path.join(localPayBaseDir, folder), payRemoteDir);
                    }
                    console.log("   ✅ All Payment Advice folders uploaded successfully.");
                } else {
                    console.log("\n⚠️ Payment Advice folder empty locally. Skipping...");
                }
            } else {
                console.log("\n⚠️ Payment Advice folder missing locally. Skipping...");
            }
        }

        // 6. ICGRN remarks (NIC SERVER ONLY)
        if (isNIC) {
            const localUploadsDir = path.join(localWorkspace, "icgrnremarks", FORMAT_YYYYMMDD);
            if (fs.existsSync(localUploadsDir) && fs.readdirSync(localUploadsDir).length > 0) {
                console.log("\n-> Uploading Icgrnremarks Uploads...");
                const remoteUploadsDir = `${PARENT_PATH}/uploads/icgrnremarks/${FORMAT_YYYYMMDD}`;
                await ssh.execCommand(`mkdir -p ${remoteUploadsDir}`);
                await ssh.putDirectory(localUploadsDir, remoteUploadsDir);
                console.log("   ✅ ICGRN remarks successfully uploaded");
            } else {
                console.log("\n⚠️ ICGRN remarks folder empty or missing locally. Skipping...");
            }
        }

        console.log(`\n🎉 UPLOADS TO ${config.name} COMPLETE!`);
    } finally {
        ssh.dispose();
    }
};

// ==========================================
// EXECUTION ROUTER
// ==========================================
if (action.toLowerCase() === "download") {
    performDownload(activeConfig).catch((err) => console.error(`❌ Download Failed:`, err.message));
} else if (action.toLowerCase() === "upload") {
    performUpload(activeConfig, sourceFolder).catch((err) => console.error(`❌ Upload Failed:`, err.message));
}