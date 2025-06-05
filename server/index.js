require('dotenv').config();
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const SftpClient = require('ssh2-sftp-client');

const app = express();
const PORT = 4000;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function sanitizeFilename(filename) {
  return filename.replace(/[()]/g, '');
}

function zipDirectory(sourceDir, outPath) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const stream = fs.createWriteStream(outPath);

  return new Promise((resolve, reject) => {
    archive
      .directory(sourceDir, false)
      .on('error', reject)
      .pipe(stream);
    stream.on('close', resolve);
    archive.finalize();
  });
}

let sftpEndpoints = [];
if (process.env.SFTP_ENDPOINTS) {
  try {
    sftpEndpoints = JSON.parse(process.env.SFTP_ENDPOINTS);
  } catch (err) {
    console.error('Failed to parse SFTP_ENDPOINTS:', err.message);
  }
}

app.get('/sftp-endpoints', (req, res) => {
  res.json(sftpEndpoints.map(({ password, ...rest }) => rest));
});

app.post('/upload', upload.single('file'), async (req, res) => {
  const filePath = req.file.path;
  const originalName = req.file?.originalname
    ? sanitizeFilename(req.file.originalname)
    : 'uploaded.eff';
  const extractDir = path.join(__dirname, 'extracted', path.basename(filePath));
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    const zip = new AdmZip(filePath);
    zip.extractAllTo(extractDir, true);

    const datFile = fs.readdirSync(extractDir).find(f => f.endsWith('.dat'));
    const lstFile = fs.readdirSync(extractDir).find(f => f.endsWith('.lst'));

    const datZip = new AdmZip(path.join(extractDir, datFile));
    const datExtractDir = path.join(extractDir, 'dat_contents');
    fs.mkdirSync(datExtractDir, { recursive: true });
    datZip.extractAllTo(datExtractDir, true);

    const files = fs.readdirSync(datExtractDir).filter(Boolean);
    res.json({
      files,
      basePath: path.basename(filePath),
      originalName
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to extract .eff/.dat file' });
  }
});

app.get('/file/:basePath/:filename', (req, res) => {
  const { basePath, filename } = req.params;
  const filePath = path.join(__dirname, 'extracted', basePath, 'dat_contents', filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

app.post('/file/:basePath/:filename', (req, res) => {
  const { basePath, filename } = req.params;
  const filePath = path.join(__dirname, 'extracted', basePath, 'dat_contents', filename);
  fs.writeFileSync(filePath, req.body.content);
  res.json({ message: 'File saved' });
});

app.get('/download/:basePath/:originalName', async (req, res) => {
  const { basePath, originalName } = req.params;
  const extractDir = path.join(__dirname, 'extracted', basePath);
  const datFile = fs.readdirSync(extractDir).find(f => f.endsWith('.dat'));
  const lstFile = fs.readdirSync(extractDir).find(f => f.endsWith('.lst'));
  const datExtractDir = path.join(extractDir, 'dat_contents');
  const updatedDatPath = path.join(extractDir, 'updated_' + datFile);
  const outputPath = path.join(__dirname, 'downloads', sanitizeFilename(originalName));

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await zipDirectory(datExtractDir, updatedDatPath);

    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(outputPath);

    await new Promise((resolve, reject) => {
      archive.pipe(output);
      archive.file(updatedDatPath, { name: datFile });
      archive.file(path.join(extractDir, lstFile), { name: lstFile });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.finalize();
    });

    res.download(outputPath);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Failed to generate .eff file' });
  }
});

app.post('/upload-to-sftp/:basePath/:originalName', async (req, res) => {
  const { basePath, originalName } = req.params;
  const { endpointName } = req.body;
  const buildEff = req.query.buildEff === 'true';

  if (!originalName) {
    console.error('❌ originalName is missing');
    return res.status(400).json({ error: 'originalName is missing from request' });
  }

  const extractDir = path.join(__dirname, 'extracted', basePath);
  const datFile = fs.readdirSync(extractDir).find(f => f.endsWith('.dat'));
  const lstFile = fs.readdirSync(extractDir).find(f => f.endsWith('.lst'));
  const datExtractDir = path.join(extractDir, 'dat_contents');
  const updatedDatPath = path.join(extractDir, 'updated_' + datFile);
  const finalEffPath = path.join(__dirname, 'downloads', sanitizeFilename(originalName));

  if (buildEff) {
    try {
      console.log('📦 Building updated .eff package...');
      fs.mkdirSync(path.dirname(finalEffPath), { recursive: true });
      await zipDirectory(datExtractDir, updatedDatPath);

      const archive = archiver('zip', { zlib: { level: 9 } });
      const output = fs.createWriteStream(finalEffPath);

      await new Promise((resolve, reject) => {
        archive.pipe(output);
        archive.file(updatedDatPath, { name: datFile });
        archive.file(path.join(extractDir, lstFile), { name: lstFile });
        output.on('close', () => {
          console.log('✅ .eff archive built:', finalEffPath);
          resolve();
        });
        archive.on('error', reject);
        archive.finalize();
      });
    } catch (err) {
      console.error('❌ Error creating .eff file:', err);
      return res.status(500).json({ error: 'Failed to repackage .eff file before upload' });
    }
  }

  if (!fs.existsSync(finalEffPath)) {
    console.error('❌ .eff file does not exist:', finalEffPath);
    return res.status(400).json({ error: 'Repackaged .eff file not found' });
  }

  const endpoint = sftpEndpoints.find(e => e.name === endpointName);
  if (!endpoint) {
    console.error('❌ No SFTP endpoint found for:', endpointName);
    return res.status(400).json({ error: 'SFTP endpoint not found' });
  }

  const sftp = new SftpClient();
  const remotePath = path.posix.join(endpoint.remotePath, sanitizeFilename(originalName));

  try {
    console.log(`🚀 Connecting to SFTP (${endpoint.name}) @ ${endpoint.host}:${endpoint.port}`);
    await sftp.connect({
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.username,
      password: endpoint.password
    });
    console.log('✅ SFTP connection established');

    const cwd = await sftp.cwd();
    console.log('📂 Remote working directory:', cwd);


    console.log(`📤 Uploading ${finalEffPath} to ${remotePath}`);
    await sftp.put(finalEffPath, remotePath);
    console.log('✅ Upload successful');

    await sftp.end();
    console.log('🔌 SFTP connection closed');

    res.json({ message: `Uploaded to ${endpoint.name}` });
  } catch (err) {
    console.error('❌ SFTP upload error:', err.message);
    res.status(500).json({ error: 'SFTP upload failed: ' + err.message });
  }
});


app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
