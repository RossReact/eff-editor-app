// File: server/index.js
const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 4000;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const extractEFF = async (effPath, extractDir) => {
  return fs.createReadStream(effPath)
    .pipe(unzipper.Extract({ path: extractDir }))
    .promise();
};

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

app.post('/upload', upload.single('file'), async (req, res) => {
  const filePath = req.file.path;
  const fileName = req.file.originalname;
  const extractDir = path.join(__dirname, 'extracted', path.basename(filePath));
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await extractEFF(filePath, extractDir);

    const lstFile = fs.readdirSync(extractDir).find(f => f.endsWith('.lst'));
    const datFile = fs.readdirSync(extractDir).find(f => f.endsWith('.dat'));
    const datPath = path.join(extractDir, datFile);
    const datExtractDir = path.join(extractDir, 'dat_contents');
    fs.mkdirSync(datExtractDir, { recursive: true });

    await fs.createReadStream(datPath)
      .pipe(unzipper.Extract({ path: datExtractDir }))
      .promise();

    const innerFiles = fs.readdirSync(datExtractDir);
    res.json({ files: innerFiles, basePath: path.basename(filePath), originalName: fileName });
  } catch (err) {
    console.error(err);
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
  const datExtractDir = path.join(extractDir, 'dat_contents');
  const datFile = fs.readdirSync(extractDir).find(f => f.endsWith('.dat'));
  const lstFile = fs.readdirSync(extractDir).find(f => f.endsWith('.lst'));

  const updatedDatPath = path.join(extractDir, 'updated_' + datFile);
  const finalEffPath = path.join(__dirname, 'downloads', originalName);
  fs.mkdirSync(path.dirname(finalEffPath), { recursive: true });

  try {
    await zipDirectory(datExtractDir, updatedDatPath);
    const effArchive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(finalEffPath);

    effArchive.pipe(output);
    effArchive.file(updatedDatPath, { name: datFile });
    effArchive.file(path.join(extractDir, lstFile), { name: lstFile });
    await effArchive.finalize();

    output.on('close', () => {
      res.download(finalEffPath);
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to repackage files' });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));