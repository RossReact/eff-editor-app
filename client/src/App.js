import React, { useState } from 'react';
import axios from 'axios';
import Editor from '@monaco-editor/react';

function App() {
  const [files, setFiles] = useState([]);
  const [basePath, setBasePath] = useState('');
  const [originalName, setOriginalName] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [content, setContent] = useState('');

  const handleUpload = async (e) => {
    const formData = new FormData();
    formData.append('file', e.target.files[0]);
    try {
      const res = await axios.post('http://localhost:4000/upload', formData);
      setFiles(res.data.files);
      setBasePath(res.data.basePath);
      setOriginalName(res.data.originalName);
    } catch (err) {
      alert('Upload failed: ' + (err.response?.data?.error || err.message));
    }
  };

  const openFile = async (filename) => {
    if (!filename.endsWith('.xml')) {
      alert('Only .xml files can be edited.');
      return;
    }
    try {
      const res = await axios.get(`http://localhost:4000/file/${basePath}/${filename}`);
      setContent(res.data);
      setSelectedFile(filename);
    } catch (err) {
      alert('Failed to open file: ' + (err.response?.data?.error || err.message));
    }
  };

  const saveFile = async () => {
    try {
      await axios.post(`http://localhost:4000/file/${basePath}/${selectedFile}`, { content });
      alert('File saved');
    } catch (err) {
      alert('Failed to save file: ' + (err.response?.data?.error || err.message));
    }
  };

  const downloadUpdatedEff = () => {
    window.location.href = `http://localhost:4000/download/${basePath}/${originalName}`;
  };

  return (
    <div style={{ padding: 20 }}>
      <h2>Upload .eff File - Do not upload files with brackets or spaces</h2>
      <input type="file" onChange={handleUpload} />
      <ul>
        {files.map(f => (
          <li key={f}>
            {f.endsWith('.xml') ? (
              <button onClick={() => openFile(f)}>{f}</button>
            ) : (
              f
            )}
          </li>
        ))}
      </ul>
      {selectedFile && (
        <div>
          <h3>Editing: {selectedFile}</h3>
          <Editor
            height="400px"
            language="xml"
            value={content}
            onChange={setContent}
          />
          <button onClick={saveFile}>Save</button>
        </div>
      )}
      {files.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <button onClick={downloadUpdatedEff}>Download Updated .eff File</button>
        </div>
      )}
    </div>
  );
}

export default App;
