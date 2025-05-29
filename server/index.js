const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const SftpClient = require('ssh2-sftp-client');
const sftpEndpoints = require('./sftp-endpoints.json');

const app = express();
const PORT = 4000;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

const sanitizeFilename = (name) => name.replace(/[\\/:*?"<>|()]/g, '_');

const zipDirectory = (source, out) => {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const stream = fs.createWriteStream(out);

  return new Promise((resolve, reject) => {
    archive
      .directory(source, false)
      .on('error', err => reject(err))
      .pipe(stream);

    stream.on('close', () => resolve());
    archive.finalize();
  });
};

app.get('/sftp-endpoints', (req, res) => {
  res.json(sftpEndpoints);
});

app.post('/upload', upload.single('file'), async (req, res) => {
  const filePath = req.file.path;
  const originalName = sanitizeFilename(req.file.originalname);
  const extractDir = path.join(__dirname, 'extracted', path.basename(filePath));
  const datExtractDir = path.join(extractDir, 'dat_contents');
  fs.mkdirSync(datExtractDir, { recursive: true });

  try {
    const zip = new AdmZip(filePath);
    zip.extractAllTo(extractDir, true);

    const datFile = fs.readdirSync(extractDir).find(f => f.endsWith('.dat'));
    const datPath = path.join(extractDir, datFile);

    const datZip = new AdmZip(datPath);
    datZip.extractAllTo(datExtractDir, true);

    const innerFiles = fs.readdirSync(datExtractDir);
    res.json({ files: innerFiles, basePath: path.basename(filePath), originalName });
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
  const sanitizedOriginalName = sanitizeFilename(originalName);
  const extractDir = path.join(__dirname, 'extracted', basePath);
  const datExtractDir = path.join(extractDir, 'dat_contents');
  const datFile = fs.readdirSync(extractDir).find(f => f.endsWith('.dat'));
  const lstFile = fs.readdirSync(extractDir).find(f => f.endsWith('.lst'));

  const updatedDatPath = path.join(extractDir, 'updated_' + datFile);
  const finalEffPath = path.join(__dirname, 'downloads', sanitizedOriginalName);
  fs.mkdirSync(path.dirname(finalEffPath), { recursive: true });

  try {
    await zipDirectory(datExtractDir, updatedDatPath);
    const effArchive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(finalEffPath);

    effArchive.pipe(output);
    effArchive.file(updatedDatPath, { name: datFile });
    effArchive.file(path.join(extractDir, lstFile), { name: lstFile });

    output.on('close', () => {
      res.download(finalEffPath);
    });

    output.on('error', (err) => {
      console.error('Error writing .eff file:', err);
      res.status(500).json({ error: 'Failed to write .eff file' });
    });

    effArchive.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to repackage files' });
  }
});

app.post('/upload-to-sftp/:basePath/:originalName', async (req, res) => {
  const { basePath, originalName } = req.params;
  const { endpointName } = req.body;
  const buildEff = req.query.buildEff === 'true';

  const endpoint = sftpEndpoints.find(e => e.name === endpointName);
  if (!endpoint) {
    return res.status(400).json({ error: 'SFTP endpoint not found' });
  }

  const sanitizedOriginalName = sanitizeFilename(originalName);
  const extractDir = path.join(__dirname, 'extracted', basePath);
  const datExtractDir = path.join(extractDir, 'dat_contents');
  const datFile = fs.readdirSync(extractDir).find(f => f.endsWith('.dat'));
  const lstFile = fs.readdirSync(extractDir).find(f => f.endsWith('.lst'));
  const updatedDatPath = path.join(extractDir, 'updated_' + datFile);
  const finalEffPath = path.join(__dirname, 'downloads', sanitizedOriginalName);

  if (buildEff) {
    try {
      fs.mkdirSync(path.dirname(finalEffPath), { recursive: true });
      await zipDirectory(datExtractDir, updatedDatPath);

      const effArchive = archiver('zip', { zlib: { level: 9 } });
      const output = fs.createWriteStream(finalEffPath);

      await new Promise((resolve, reject) => {
        effArchive.pipe(output);
        effArchive.file(updatedDatPath, { name: datFile });
        effArchive.file(path.join(extractDir, lstFile), { name: lstFile });
        output.on('close', resolve);
        effArchive.on('error', reject);
        effArchive.finalize();
      });
    } catch (err) {
      console.error('Error repackaging .eff file:', err);
      return res.status(500).json({ error: 'Failed to repackage .eff file before upload' });
    }
  }

  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.username,
      password: endpoint.password
    });

    const remotePath = `${endpoint.remotePath}/${sanitizedOriginalName}`;
    await sftp.put(finalEffPath, remotePath);
    await sftp.end();

    res.json({ message: `Uploaded to ${endpoint.name}` });
  } catch (err) {
    console.error('SFTP upload error:', err.message);
    res.status(500).json({ error: 'SFTP upload failed' });
  }
});


app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
