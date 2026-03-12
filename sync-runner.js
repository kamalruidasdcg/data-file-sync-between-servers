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
  process.exit(1);
}
if (!serverName || !["NIC", "LAN"].includes(serverName.toUpperCase())) {
  console.error("❌ Error: --server must be 'NIC' or 'LAN'");
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
const FORMAT_YYYYMMDD = targetDate; // "20260311"
const FORMAT_YYYYMM = `${yyyy}${mm}`; // "202603"
const PARENT_PATH = "/var/www/html/obps/backend_obps"

// ==========================================
// 3. SERVER CONFIGURATIONS
// ==========================================
const SERVERS = {
  NIC: {
    name: "NIC",
    host: "10.212.122.153",
    port: 22,
    username: "nic_user",
    password: "nic_password",
    apiUrl: "http://10.18.7.123:4001/api/sync/syncUnzip2", // Adjust port/path for NIC
  },
  LAN: {
    name: "LAN",
    host: "10.18.7.123",
    port: 22,
    username: "grse",
    password: "Kolkata@4321",
    apiUrl: "https://obpsback.grse.in/api/sync/syncUnzip2", // Adjust port/path for LAN
  },
};

const activeConfig = SERVERS[serverName.toUpperCase()];

const ensureLocalDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

// ==========================================
// GENERIC DOWNLOAD LOGIC
// ==========================================
const performDownload = async (config) => {
  const localWorkspace = path.join(__dirname, "SYNC_WORKSPACE", `DOWNLOADED_FROM_${config.name}_${FORMAT_YYYYMMDD}`);
  console.log(`\n🚀 [DOWNLOAD MODE] Pulling data from ${config.name} for ${FORMAT_YYYYMMDD}...`);
  ensureLocalDir(localWorkspace);

  await ssh.connect(config);
  console.log(`✅ Connected to ${config.name} Server.`);

  try {
    // 1. Sync Zip
    console.log("\n-> Downloading Database Sync Zip...");
    await ssh.getFile(path.join(localWorkspace, "sync_data.zip"), `${PARENT_PATH}/sync/zipData/${FORMAT_DD_MM_YYYY}/sync_data.zip`);

    // 2. PO Tar
    console.log("-> Taring and Downloading POs...");
    const tarName = `${FORMAT_YYYYMMDD}po.tar`;
    await ssh.execCommand(`tar -cvf ${tarName} *_${FORMAT_YYYYMMDD}_*`, { cwd: `${PARENT_PATH}/uploads/po` });
    await ssh.getFile(path.join(localWorkspace, tarName), `${PARENT_PATH}/uploads/po/${tarName}`);
    await ssh.execCommand(`rm ${tarName}`, { cwd: `${PARENT_PATH}/uploads/po` });

    // 3. General Uploads
    console.log("-> Downloading General Uploads...");
    const uploadsLocal = path.join(localWorkspace, "uploads", FORMAT_YYYYMMDD );
    ensureLocalDir(uploadsLocal);
    await ssh.getDirectory(uploadsLocal, `${PARENT_PATH}/uploads/${FORMAT_YYYYMMDD}`);

    // 4. Compliances
    console.log("-> Downloading Compliances...");
    const compLocal = path.join(localWorkspace, "compliances");
    ensureLocalDir(compLocal);
    await ssh.getDirectory(compLocal, `${PARENT_PATH}/uploads/compliances/${FORMAT_YYYYMM}/${dd}`);

    // 5. Payment Advice
    console.log("-> Downloading Payment Advice...");
    const payLocal = path.join(localWorkspace, "paymentadvice");
    ensureLocalDir(payLocal);
    await ssh.getDirectory(payLocal, `${PARENT_PATH}/uploads/paymentadvice/${FORMAT_YYYYMMDD}`);

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

  const localWorkspace = path.join(__dirname, "SYNC_WORKSPACE", `DOWNLOADED_FROM_${sourceName.toUpperCase()}_${FORMAT_YYYYMMDD}`);
  console.log(`\n🚀 [UPLOAD MODE] Pushing data from ${sourceName} to ${config.name} for ${FORMAT_YYYYMMDD}...`);

  if (!fs.existsSync(localWorkspace)) {
    console.error(`❌ Error: Local folder ${localWorkspace} does not exist. Run the download step first!`);
    process.exit(1);
  }

  await ssh.connect(config);
  console.log(`✅ Connected to ${config.name} Server.`);

  try {
    // 1. Database Sync Zip
    console.log("\n-> Uploading Database Sync Zip...");
    const remoteZipDir = `/sync/zipData/${FORMAT_YYYYMMDD}`;
    await ssh.execCommand(`mkdir -p ${remoteZipDir}`);
    await ssh.putFile(path.join(localWorkspace, "sync_data.zip"), `${remoteZipDir}/sync_data.zip`);

    // Trigger API
    console.log(`-> Triggering ${config.name} Database Ingestion API...`);
    try {
      const response = await axios.post(config.apiUrl, { from_date: FORMAT_DD_MM_YYYY });
      console.log(`   API Success: ${response.data.msg}`);
    } catch (apiErr) {
      console.error(`   ⚠️ API Error: ${apiErr.message}`);
    }

    // 2. Upload and Untar POs
    console.log("\n-> Uploading and Extracting POs...");
    const tarName = `${FORMAT_YYYYMMDD}po.tar`;
    await ssh.putFile(path.join(localWorkspace, tarName), `/uploads/po/${tarName}`);
    await ssh.execCommand(`tar -xvf ${tarName}`, { cwd: `/uploads/po` });
    await ssh.execCommand(`rm ${tarName}`, { cwd: `/uploads/po` });

    // 3. General Uploads
    console.log("-> Uploading General Uploads...");
    await ssh.execCommand(`mkdir -p /uploads/${FORMAT_YYYYMMDD}`);
    await ssh.putDirectory(path.join(localWorkspace, "uploads"), `/uploads/${FORMAT_YYYYMMDD}`);

    // 4. Compliances
    console.log("-> Uploading Compliances...");
    const compRemoteDir = `/uploads/compliances/${FORMAT_YYYYMM}/${dd}`;
    await ssh.execCommand(`mkdir -p ${compRemoteDir}`);
    await ssh.putDirectory(path.join(localWorkspace, "compliances"), compRemoteDir);

    // 5. Payment Advice
    console.log("-> Uploading Payment Advice...");
    const payRemoteDir = `/uploads/paymentadvice/${FORMAT_YYYYMMDD}`;
    await ssh.execCommand(`mkdir -p ${payRemoteDir}`);
    await ssh.putDirectory(path.join(localWorkspace, "paymentadvice"), payRemoteDir);

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
} else {
  performUpload(activeConfig, sourceFolder).catch((err) => console.error(`❌ Upload Failed:`, err.message));
}

// How to use it:

// Scenario A: Syncing NIC data over to the LAN Server

//     Connect to NIC VPN. Run:
//     node sync-runner.js --action=download --server=NIC --date=20260311

//     Disconnect VPN, connect to LAN. Run:
//     node sync-runner.js --action=upload --server=LAN --source=NIC --date=20260311

// Scenario B: Syncing LAN data over to the NIC Server

//     Connect to LAN. Run:
//     node sync-runner.js --action=download --server=LAN --date=20260311

//     Connect to NIC VPN. Run:
//     node sync-runner.js --action=upload --server=NIC --source=LAN --date=20260311