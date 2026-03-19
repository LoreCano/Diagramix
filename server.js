const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const cors = require('cors');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const fs = require('fs');
const { parseJava, parseCCpp, buildPlantUML } = require('./parser');

const app = express();
const PORT = process.env.PORT || 5050; // Porta dinamica per Render

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Multer: salva ZIP in memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' ||
        file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are supported.'));
    }
  }
});

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024, ...(opts || {}) }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// Funzione per normalizzare GitHub repo URL
function normalizeGithubRepoUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error('Invalid URL.');
  }

  const host = String(u.hostname || '').toLowerCase();
  if (u.protocol !== 'https:') throw new Error('Only https:// GitHub URLs are supported.');
  if (host !== 'github.com' && host !== 'www.github.com') throw new Error('Only github.com repositories are supported.');

  const parts = String(u.pathname || '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Invalid GitHub repository URL. Expected: https://github.com/<owner>/<repo>');

  const owner = parts[0];
  const repo = String(parts[1]).replace(/\.git$/i, '');
  return {
    owner,
    repo,
    display: `${owner}/${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

// Funzione per raccogliere file sorgente da una cartella
async function collectSourceFiles(rootDir) {
  const allowedExt = new Set(['.java', '.c', '.cpp', '.h', '.hpp']);
  const ignoreDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'out', '.idea', '.vscode', '.venv']);
  const maxFileBytes = 2 * 1024 * 1024;

  const out = [];

  async function walk(dir) {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ignoreDirs.has(ent.name)) continue;
        await walk(full);
        continue;
      }
      if (!ent.isFile()) continue;

      const ext = path.extname(ent.name).toLowerCase();
      if (!allowedExt.has(ext)) continue;

      const st = await fs.promises.stat(full);
      if (st.size > maxFileBytes) continue;

      const buf = await fs.promises.readFile(full);
      const content = buf.toString('utf8');
      const name = path.relative(rootDir, full).replace(/\\/g, '/');
      out.push({ name, ext, content });
    }
  }

  await walk(rootDir);
  return out;
}

// --- Endpoints principali ---

app.post('/api/analyze', upload.single('project'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();

    const sourceFiles = [];

    entries.forEach(entry => {
      if (entry.isDirectory) return;
      const name = entry.entryName;
      const ext = path.extname(name).toLowerCase();
      if (['.java', '.c', '.cpp', '.h', '.hpp'].includes(ext)) {
        const content = entry.getData().toString('utf8');
        sourceFiles.push({ name, ext, content });
      }
    });

    if (!sourceFiles.length) return res.status(422).json({ error: 'No Java/C++ source files found in the ZIP.' });

    const allClasses = [];
    sourceFiles.forEach(file => {
      let parsed = [];
      if (file.ext === '.java') parsed = parseJava(file.content, file.name);
      else parsed = parseCCpp(file.content, file.name);
      allClasses.push(...parsed);
    });

    const plantUml = buildPlantUML(allClasses);

    res.json({
      project: { kind: 'zip', name: req.file.originalname },
      stats: { filesAnalyzed: sourceFiles.length },
      classes: allClasses,
      plantUml,
    });
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message || 'Internal server error.' });
  }
});

// Endpoint per analizzare repository GitHub
app.post('/api/analyze-git', express.json(), async (req, res) => {
  let tmpBase = null;
  try {
    const { repoUrl } = req.body || {};
    if (!repoUrl) return res.status(400).json({ error: 'Missing URL.' });

    const repo = normalizeGithubRepoUrl(repoUrl);

    // Assicuriamoci che git sia disponibile
    try {
      await execFileP('git', ['--version']);
    } catch {
      return res.status(500).json({ error: 'git is required on the server to analyze GitHub repositories.' });
    }

    tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'diagramix-'));
    const repoDir = path.join(tmpBase, 'repo');

    await execFileP('git', ['clone', '--depth', '1', '--single-branch', '--no-tags', '--quiet', repo.cloneUrl, repoDir]);

    const sourceFiles = await collectSourceFiles(repoDir);
    if (!sourceFiles.length) return res.status(422).json({ error: 'No Java/C/C++ source files found in the repository.' });

    const allClasses = [];
    for (const file of sourceFiles) {
      let parsed = [];
      if (file.ext === '.java') parsed = parseJava(file.content, file.name);
      else parsed = parseCCpp(file.content, file.name);
      allClasses.push(...parsed);
    }

    const plantUml = buildPlantUML(allClasses);

    res.json({
      project: { kind: 'github', repo: repo.display, url: repo.cloneUrl },
      stats: { filesAnalyzed: sourceFiles.length },
      classes: allClasses,
      plantUml,
    });
  } catch (err) {
    console.error('Git analysis error:', err);
    res.status(500).json({ error: err?.message || 'Internal server error.' });
  } finally {
    if (tmpBase) {
      try { await fs.promises.rm(tmpBase, { recursive: true, force: true }); } catch {}
    }
  }
});

// Avvio server
app.listen(PORT, () => {
  console.log(`Diagramix backend running on port ${PORT}`);
});
