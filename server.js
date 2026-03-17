const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const cors = require('cors');
const path = require('path');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { parseJava, parseCCpp, buildPlantUML } = require('./parser');

const app = express();
const PORT = 5050;

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
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('Invalid GitHub repository URL.');
  }

  return {
    owner,
    repo,
    display: `${owner}/${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

async function collectSourceFiles(rootDir) {
  const allowedExt = new Set(['.java', '.c', '.cpp', '.h', '.hpp']);
  const ignoreDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'out', '.idea', '.vscode', '.venv']);
  const maxFileBytes = 2 * 1024 * 1024;

  /** @type {{ name: string, ext: string, content: string }[]} */
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

/**
 * POST /api/analyze
 * Body: multipart/form-data con campo "project" (ZIP)
 * Response: { classes, plantUml, stats }
 */
app.post('/api/analyze', upload.single('project'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file received.' });
    }

    // Estrai il ZIP dalla memoria
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();

    /** @type {{ name: string, ext: string, content: string }[]} */
    const sourceFiles = [];

    entries.forEach(entry => {
      if (entry.isDirectory) return;

      const name = entry.entryName;
      const ext = path.extname(name).toLowerCase();

      // Supporta Java, C, C++
      if (['.java', '.c', '.cpp', '.h', '.hpp'].includes(ext)) {
        const content = entry.getData().toString('utf8');
        sourceFiles.push({ name, ext, content });
      }
    });

    if (sourceFiles.length === 0) {
      return res.status(422).json({
        error: 'No Java/C++ source files found in the ZIP.'
      });
    }

    // Parsing per tipo
    const allClasses = [];

    sourceFiles.forEach(file => {
      let parsed = [];
      if (file.ext === '.java') {
        parsed = parseJava(file.content, file.name);
      } else if (['.c', '.cpp', '.h', '.hpp'].includes(file.ext)) {
        parsed = parseCCpp(file.content, file.name);
      }
      allClasses.push(...parsed);
    });

    // Genera PlantUML
    const plantUml = buildPlantUML(allClasses);

    res.json({
      project: { kind: 'zip', name: req.file.originalname },
      stats: {
        filesAnalyzed: sourceFiles.length,
      },
      classes: allClasses,
      plantUml,
    });

  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message || 'Internal server error.' });
  }
});

/**
 * POST /api/render/:format
 * Body: text/plain (PlantUML source)
 * Response: image (png/svg) proxied from Kroki (POST, so no 414 URI-limit)
 */
app.post('/api/render/:format', express.text({ type: '*/*', limit: '2mb' }), (req, res) => {
  try {
    const format = String(req.params.format || '').toLowerCase();
    if (!['png', 'svg'].includes(format)) {
      return res.status(400).json({ error: 'Unsupported format. Use png or svg.' });
    }

    const plantUml = typeof req.body === 'string' ? req.body : '';
    if (!plantUml.trim()) {
      return res.status(400).json({ error: 'Empty body: missing PlantUML source.' });
    }

    const base = process.env.KROKI_BASE_URL || 'https://kroki.io';
    const krokiUrl = new URL(`/plantuml/${format}`, base);

    const upstream = https.request(
      {
        protocol: krokiUrl.protocol,
        hostname: krokiUrl.hostname,
        port: krokiUrl.port || 443,
        path: krokiUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': Buffer.byteLength(plantUml, 'utf8'),
          'User-Agent': 'diagramix-backend'
        }
      },
      (up) => {
        // Mirror status code and content-type for the frontend.
        res.statusCode = up.statusCode || 502;
        const ct = up.headers['content-type'];
        if (ct) res.setHeader('Content-Type', ct);
        up.pipe(res);
      }
    );

    upstream.on('error', (e) => {
      console.error('Kroki render error:', e);
      if (!res.headersSent) res.status(502).json({ error: 'Kroki render failed.' });
    });

    upstream.write(plantUml, 'utf8');
    upstream.end();
  } catch (e) {
    console.error('Render error:', e);
    res.status(500).json({ error: e.message || 'Internal server error.' });
  }
});

/**
 * POST /api/analyze-git
 * Body: { repoUrl: "https://github.com/..." }
 * Clona (superficialmente) e analizza — richiede git installato
 */
app.post('/api/analyze-git', express.json(), async (req, res) => {
  let tmpBase = null;
  try {
    const { repoUrl } = req.body || {};
    if (!repoUrl) return res.status(400).json({ error: 'Missing URL.' });

    const repo = normalizeGithubRepoUrl(repoUrl);

    // Ensure git exists
    try {
      await execFileP('git', ['--version']);
    } catch {
      return res.status(500).json({ error: 'git is required on the server to analyze GitHub repositories.' });
    }

    tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'diagramix-'));
    const repoDir = path.join(tmpBase, 'repo');

    await execFileP('git', ['clone', '--depth', '1', '--single-branch', '--no-tags', '--quiet', repo.cloneUrl, repoDir]);

    const sourceFiles = await collectSourceFiles(repoDir);
    if (sourceFiles.length === 0) {
      return res.status(422).json({
        error: 'No Java/C/C++ source files found in the repository.'
      });
    }

    const allClasses = [];
    for (const file of sourceFiles) {
      let parsed = [];
      if (file.ext === '.java') {
        parsed = parseJava(file.content, file.name);
      } else if (['.c', '.cpp', '.h', '.hpp'].includes(file.ext)) {
        parsed = parseCCpp(file.content, file.name);
      }
      allClasses.push(...parsed);
    }

    const plantUml = buildPlantUML(allClasses);

    res.json({
      project: { kind: 'github', repo: repo.display, url: repo.cloneUrl },
      stats: {
        filesAnalyzed: sourceFiles.length,
      },
      classes: allClasses,
      plantUml,
    });
  } catch (err) {
    console.error('Git analysis error:', err);
    res.status(500).json({ error: err && err.message ? err.message : 'Internal server error.' });
  } finally {
    if (tmpBase) {
      try {
        await fs.promises.rm(tmpBase, { recursive: true, force: true });
      } catch {}
    }
  }
});

app.listen(PORT, () => {
  console.log(`\nOK Diagramix backend running on http://localhost:${PORT}`);
  console.log(`   POST /api/analyze-git  -> GitHub repo URL + analysis`);
  console.log(`   GET  /             -> frontend\n`);
});
