// Web Worker: Invisible Python execution engine
// Main thread sends code → Worker executes → Returns generated files
// The user NEVER interacts with or sees this worker

let pyodide = null;
let installedPackages = new Set();

async function ensurePyodide() {
  if (pyodide) return pyodide;
  importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
  pyodide = await loadPyodide();
  await pyodide.loadPackage('micropip');
  return pyodide;
}

async function installPackages(packages) {
  const micropip = pyodide.pyimport('micropip');
  const toInstall = packages.filter(p => !installedPackages.has(p));
  if (toInstall.length > 0) {
    await micropip.install(toInstall);
    toInstall.forEach(p => installedPackages.add(p));
  }
}

self.onmessage = async function(e) {
  const { type, id, code, packages } = e.data;
  if (type !== 'exec') return;

  try {
    self.postMessage({ type: 'status', id, message: 'Loading Python runtime...' });
    await ensurePyodide();

    if (packages && packages.length > 0) {
      self.postMessage({ type: 'status', id, message: `Installing ${packages.join(', ')}...` });
      await installPackages(packages);
    }

    self.postMessage({ type: 'status', id, message: 'Executing...' });
    await pyodide.runPythonAsync(code);

    // Read generated files from /output/
    const fileList = pyodide.runPython(`
import os, json
files = []
if os.path.exists('/output'):
    for f in os.listdir('/output'):
        path = f'/output/{f}'
        if os.path.isfile(path):
            files.append({'name': f, 'size': os.path.getsize(path)})
json.dumps(files)
    `);
    
    const outputFiles = JSON.parse(fileList);
    const results = [];
    for (const file of outputFiles) {
      const data = pyodide.FS.readFile(`/output/${file.name}`);
      results.push({ name: file.name, data: data, size: file.size });
    }

    // Clean up
    pyodide.runPython(`
import shutil, os
if os.path.exists('/output'): shutil.rmtree('/output')
os.makedirs('/output', exist_ok=True)
    `);

    self.postMessage({ type: 'result', id, files: results }, 
      results.map(f => f.data.buffer));
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message || String(err) });
  }
};
