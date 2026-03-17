/**
 * parser.js
 * Parsing leggero di Java e C/C++ tramite regex.
 * Per un parsing completo in produzione:
 *   - Java  → usa java-parser (npm)
 *   - C/C++ → usa node bindings di Clang/Tree-sitter
 */

// ─────────────────────────────────────────────
//  JAVA PARSER
// ─────────────────────────────────────────────

/**
 * Estrae classi, interfacce, metodi, attributi e relazioni da codice Java.
 * @param {string} src  - contenuto del file
 * @param {string} file - nome file
 * @returns {ClassModel[]}
 */
function parseJava(src, file) {
  const classes = [];

  // Rimuovi commenti
  const clean = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Package (unico per file in Java)
  const pkgMatch = /^\s*package\s+([\w.]+)\s*;/m.exec(clean);
  const pkg = pkgMatch ? pkgMatch[1] : null;

  // Cerca dichiarazioni class/interface/enum
  const classRe = /(?:public|protected|private|abstract|final)?\s*(?:static\s+)?(class|interface|enum)\s+(\w+)(?:\s+extends\s+([\w,\s]+?))?(?:\s+implements\s+([\w,\s]+?))?\s*\{/g;

  let match;
  while ((match = classRe.exec(clean)) !== null) {
    const type      = match[1];           // class | interface | enum
    const name      = match[2];
    const extendsRaw  = match[3] || '';
    const implementsRaw = match[4] || '';

    const body = extractBlock(clean, match.index + match[0].length - 1);

    const methods    = extractJavaMethods(body);
    const fields     = extractJavaFields(body);
    const relations  = [];

    // Ereditarietà
    extendsRaw.split(',').map(s => s.trim()).filter(Boolean).forEach(parent => {
      relations.push({ kind: 'extends', target: parent });
    });

    // Implementazione
    implementsRaw.split(',').map(s => s.trim()).filter(Boolean).forEach(iface => {
      relations.push({ kind: 'implements', target: iface });
    });

    classes.push({ name, type, file, package: pkg, fields, methods, relations });
  }

  return classes;
}

function extractJavaMethods(body) {
  const methods = [];
  // Firma metodo: [visibility] [static] [tipo] nomeMetodo(params)
  const re = /(public|protected|private|package)?\s*(static\s+|abstract\s+|final\s+)*([\w<>\[\]]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s]+)?\s*(?:\{|;)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const vis    = m[1] || 'package';
    const retType = m[3];
    const name   = m[4];
    const params = m[5].trim();
    const isStatic = (m[2] || '').includes('static');

    // Filtra costrutti Java non-metodo
    if (['if','while','for','switch','catch','return'].includes(name)) continue;
    if (retType === 'return') continue;

    methods.push({
      visibility: visSymbol(vis),
      name,
      returnType: retType,
      params,
      isStatic,
    });
  }
  return methods;
}

function extractJavaFields(body) {
  const fields = [];
  const re = /^\s*(public|protected|private|package)?\s*(static\s+|final\s+)*([\w<>\[\]]+)\s+(\w+)\s*(?:=\s*[^;]+)?;/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const vis   = m[1] || 'package';
    const type  = m[3];
    const name  = m[4];
    if (['return','class','new','import'].includes(name)) continue;
    if (['void','if','for','while'].includes(type)) continue;
    fields.push({ visibility: visSymbol(vis), name, type });
  }
  return fields;
}

// ─────────────────────────────────────────────
//  C / C++ PARSER
// ─────────────────────────────────────────────

function parseCCpp(src, file) {
  const classes = [];

  const clean = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // struct / class
  const classRe = /(class|struct)\s+(\w+)(?:\s*:\s*(?:public|protected|private)?\s*([\w:]+))?\s*\{/g;

  let match;
  while ((match = classRe.exec(clean)) !== null) {
    const type     = match[1] === 'struct' ? 'struct' : 'class';
    const name     = match[2];
    const parent   = match[3] || null;

    const body     = extractBlock(clean, match.index + match[0].length - 1);
    const methods  = extractCppMethods(body);
    const fields   = extractCppFields(body);
    const relations = [];

    if (parent) {
      relations.push({ kind: 'extends', target: parent });
    }

    // Cerca puntatori a altre strutture (composizione/dipendenza)
    const ptrRe = /(\w+)\s*\*/g;
    let pm;
    while ((pm = ptrRe.exec(body)) !== null) {
      const candidate = pm[1];
      if (candidate !== name && /^[A-Z]/.test(candidate)) {
        if (!relations.find(r => r.target === candidate)) {
          relations.push({ kind: 'uses', target: candidate });
        }
      }
    }

    classes.push({ name, type, file, fields, methods, relations });
  }

  return classes;
}

function extractCppMethods(body) {
  const methods = [];
  // tipo nomeMetodo(params) con corpo o ;
  const re = /(?:virtual\s+|static\s+|inline\s+|explicit\s+)?([\w:*&<>]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:const)?\s*(?:override|final)?\s*(?:\{|;|=\s*0)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const retType = m[1];
    const name    = m[2];
    const params  = m[3].trim();
    if (['if','while','for','switch'].includes(name)) continue;
    if (retType === 'return') continue;
    methods.push({ visibility: '+', name, returnType: retType, params, isStatic: false });
  }
  return methods;
}

function extractCppFields(body) {
  const fields = [];
  // Cerca variabili membro semplici
  const sections = { public: '+', protected: '#', private: '-' };
  let currentVis = '-'; // default C++ class è private

  const lines = body.split('\n');
  lines.forEach(line => {
    const trim = line.trim();
    if (/^public\s*:/.test(trim))    { currentVis = '+'; return; }
    if (/^protected\s*:/.test(trim)) { currentVis = '#'; return; }
    if (/^private\s*:/.test(trim))   { currentVis = '-'; return; }

    const fieldRe = /^([\w:*&<>]+)\s+(\w+)\s*(?:=\s*[^;]+)?;$/;
    const fm = fieldRe.exec(trim);
    if (fm) {
      const type = fm[1];
      const name = fm[2];
      if (['return','class','struct','if','for','while'].includes(name)) return;
      fields.push({ visibility: currentVis, name, type });
    }
  });
  return fields;
}

// ─────────────────────────────────────────────
//  PLANTUML GENERATOR
// ─────────────────────────────────────────────

/**
 * Converte l'array di ClassModel in codice PlantUML.
 * @param {ClassModel[]} classes
 * @returns {string}
 */
function buildPlantUML(classes) {
  const lines = ['@startuml', 'skinparam classBackgroundColor #1a1d27', 'skinparam classBorderColor #3d4460', 'skinparam classArrowColor #00e5a0', 'skinparam shadowing false', ''];

  // Dichiarazioni
  classes.forEach(cls => {
    const keyword = cls.type === 'interface' ? 'interface'
                  : cls.type === 'enum'      ? 'enum'
                  : 'class';

    lines.push(`${keyword} ${cls.name} {`);

    // Campi
    cls.fields.forEach(f => {
      lines.push(`  ${f.visibility}${f.name} : ${f.type}`);
    });

    if (cls.fields.length > 0 && cls.methods.length > 0) {
      lines.push('  --');
    }

    // Metodi (tutti)
    cls.methods.forEach(m => {
      const params = m.params || '';
      const ret = m.returnType ? ` : ${m.returnType}` : '';
      lines.push(`  ${m.visibility}${m.name}(${params})${ret}`);
    });

    lines.push('}');
    lines.push('');
  });

  // Relazioni
  classes.forEach(cls => {
    cls.relations.forEach(rel => {
      if (rel.kind === 'extends') {
        lines.push(`${rel.target} <|-- ${cls.name}`);
      } else if (rel.kind === 'implements') {
        lines.push(`${rel.target} <|.. ${cls.name}`);
      } else if (rel.kind === 'uses') {
        // Solo se la classe target esiste nel modello
        if (classes.find(c => c.name === rel.target)) {
          lines.push(`${cls.name} ..> ${rel.target}`);
        }
      }
    });
  });

  lines.push('');
  lines.push('@enduml');
  return lines.join('\n');
}

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────

/**
 * Estrae il blocco { ... } bilanciato partendo dall'indice dell'apertura.
 */
function extractBlock(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  let start = -1;

  while (i < src.length) {
    if (src[i] === '{') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i);
    }
    i++;
  }
  return src.slice(start); // fallback
}

function visSymbol(v) {
  const map = { public: '+', protected: '#', private: '-', package: '~' };
  return map[v] || '~';
}

module.exports = { parseJava, parseCCpp, buildPlantUML };
