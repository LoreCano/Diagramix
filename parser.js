/**
 * parser.js — versione ultra ottimizzata (FSM + scanning strutturato)
 */

// ─────────────────────────────────────────────
//  CORE UTILS (FSM & Quote-Aware Scanners)
// ─────────────────────────────────────────────

/**
 * Rimuove i commenti monolinea e multilinea rispettando le stringhe e i caratteri letterali.
 * Complessità temporale: O(N)
 */
function removeComments(src) {
  let result = '';
  let inString = false;
  let inChar = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1] || '';

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        result += c; // preserva la riga per allineamento
      }
      continue;
    }

    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++; // salta '/'
      }
      continue;
    }

    if (inString) {
      result += c;
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (inChar) {
      result += c;
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === "'") {
        inChar = false;
      }
      continue;
    }

    // Rileva inizio commenti o stringhe
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else if (c === '"') {
      inString = true;
      result += c;
    } else if (c === "'") {
      inChar = true;
      result += c;
    } else {
      result += c;
    }
  }

  return result;
}

/**
 * Estrae le istruzioni top-level tenendo traccia delle virgolette per ignorare le parentesi graffe interne alle stringhe.
 * Complessità temporale: O(N)
 */
function extractTopLevelStatements(body) {
  const result = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let inChar = false;
  let escaped = false;

  for (let i = 0; i < body.length; i++) {
    const c = body[i];

    if (inString) {
      current += c;
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (inChar) {
      current += c;
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === "'") {
        inChar = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      current += c;
      continue;
    }

    if (c === "'") {
      inChar = true;
      current += c;
      continue;
    }

    if (c === '{') depth++;
    if (c === '}') depth--;

    if (depth >= 0) {
      current += c;
    }

    if (depth === 0) {
      if (c === ';' || c === '}') {
        result.push(current.trim());
        current = '';
      }
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result.map(s => s.trim()).filter(Boolean);
}

/**
 * Estrae un blocco tra graffe tenendo traccia delle virgolette per ignorare le parentesi graffe interne a stringhe o commenti.
 */
function extractBlock(src, startIdx) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let inChar = false;
  let escaped = false;

  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (inChar) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === "'") {
        inChar = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "'") {
      inChar = true;
      continue;
    }

    if (c === '{') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i);
    }
  }

  return '';
}

function visSymbol(v) {
  return { public: '+', protected: '#', private: '-', package: '~' }[v] || '~';
}

const INVALID = new Set([
  'if','else','while','for','switch','case','break','continue',
  'return','catch','try','do','new','delete','sizeof'
]);

/**
 * Estrae i tipi di riferimento dai parametri per identificare le relazioni "uses" di associazione.
 */
function extractReferencedTypes(typeStr) {
  if (!typeStr) return [];
  const parts = typeStr.split(/[<>,\[\]\s\*&]/).map(p => p.trim()).filter(Boolean);
  
  const primitives = new Set([
    'byte', 'short', 'int', 'long', 'float', 'double', 'boolean', 'char', 'void',
    'Byte', 'Short', 'Integer', 'Long', 'Float', 'Double', 'Boolean', 'Character', 'Void',
    'String', 'Object', 'List', 'Set', 'Map', 'HashMap', 'ArrayList', 'vector', 'string',
    'std::string', 'int32_t', 'int64_t', 'uint32_t', 'uint64_t', 'size_t', 'bool'
  ]);

  return parts.filter(p => !primitives.has(p) && /^[A-Za-z_]\w*$/.test(p));
}

// ─────────────────────────────────────────────
//  JAVA PARSER
// ─────────────────────────────────────────────

function parseJava(src, file) {
  const clean = removeComments(src);
  const classes = [];

  const pkgMatch = /^\s*package\s+([\w.]+)\s*;/m.exec(clean);
  const pkg = pkgMatch ? pkgMatch[1] : null;

  // Supporta generics <...> opzionali
  const classRe = /(class|interface|enum)\s+(\w+)(?:\s*<[^{]+?>)?(?:\s+extends\s+([\w\s<>,.]+))?(?:\s+implements\s+([\w\s<>,.]+))?\s*\{/g;

  let m;
  while ((m = classRe.exec(clean))) {
    const name = m[2];
    const type = m[1];

    const body = extractBlock(clean, m.index + m[0].length - 1);
    const statements = extractTopLevelStatements(body);

    const fields = [];
    const methods = [];
    const relations = [];

    statements.forEach(stmt => {
      // METODI & COSTRUTTORI (Return type opzionale per supportare costruttori)
      const methodMatch = /^(public|protected|private)?\s*(static\s+|abstract\s+|final\s+)*(?:([\w<>\[\]]+)\s+)?(\w+)\s*\(([^)]*)\)/.exec(stmt);

      if (methodMatch) {
        const nameVal = methodMatch[4];
        if (!INVALID.has(nameVal)) {
          methods.push({
            visibility: visSymbol(methodMatch[1] || 'package'),
            name: nameVal,
            returnType: methodMatch[3] || '',
            params: methodMatch[5].trim(),
            isStatic: (methodMatch[2] || '').includes('static')
          });
          return;
        }
      }

      // CAMPI
      const fieldMatch = /^(public|protected|private)?\s*(static\s+|final\s+)*([\w<>\[\]]+)\s+(\w+)\s*(=.*)?;/.exec(stmt);

      if (fieldMatch) {
        const nameVal = fieldMatch[4];
        const typeVal = fieldMatch[3];

        if (!INVALID.has(nameVal) && typeVal !== 'void') {
          fields.push({
            visibility: visSymbol(fieldMatch[1] || 'package'),
            name: nameVal,
            type: typeVal
          });

          // Estrae associazioni "uses"
          const refs = extractReferencedTypes(typeVal);
          refs.forEach(ref => {
            if (ref !== name && ref !== nameVal) {
              relations.push({ kind: 'uses', target: ref });
            }
          });
        }
      }
    });

    // Relazioni extends e implements
    if (m[3]) {
      m[3].split(',').map(s => s.trim()).filter(Boolean).forEach(p => {
        const target = p.replace(/<.*>/g, '').trim();
        if (target) relations.push({ kind: 'extends', target });
      });
    }

    if (m[4]) {
      m[4].split(',').map(s => s.trim()).filter(Boolean).forEach(i => {
        const target = i.replace(/<.*>/g, '').trim();
        if (target) relations.push({ kind: 'implements', target });
      });
    }

    classes.push({ name, type, file, package: pkg, fields, methods, relations });
  }

  return classes;
}

// ─────────────────────────────────────────────
//  C / C++ PARSER
// ─────────────────────────────────────────────

function parseCCpp(src, file) {
  const clean = removeComments(src);
  const classes = [];

  // Supporta eredità multipla e generic template
  const classRe = /(class|struct)\s+(\w+)(?:\s*:\s*(?:public|protected|private)?\s*([\w:<>, ]+))?\s*\{/g;

  let m;
  while ((m = classRe.exec(clean))) {
    const name = m[2];
    const type = m[1];

    const body = extractBlock(clean, m.index + m[0].length - 1);
    const statements = extractTopLevelStatements(body);

    const fields = [];
    const methods = [];
    const relations = [];

    let visibility = (type === 'struct') ? '+' : '-';

    statements.forEach(stmt => {
      stmt = stmt.trim();

      // Cambiamento di visibilità
      if (/^\s*public\s*:/.test(stmt)) {
        visibility = '+';
        return;
      }
      if (/^\s*protected\s*:/.test(stmt)) {
        visibility = '#';
        return;
      }
      if (/^\s*private\s*:/.test(stmt)) {
        visibility = '-';
        return;
      }

      // METODI (Supporta virtual, static, inline, costruttori/distruttori)
      const mm = /^(virtual\s+|inline\s+|explicit\s+|static\s+)*(?:([\w:*&<>]+)\s+)?(~?\w+)\s*\(([^)]*)\)/.exec(stmt);

      if (mm) {
        const nameVal = mm[3];
        if (!INVALID.has(nameVal)) {
          methods.push({
            visibility,
            name: nameVal,
            returnType: mm[2] || '',
            params: mm[4].trim(),
            isStatic: (mm[1] || '').includes('static')
          });
          return;
        }
      }

      // CAMPI
      const fm = /^(static\s+|const\s+|mutable\s+)*([\w:*&<>]+)\s+(\w+)\s*(=.*)?;/.exec(stmt);

      if (fm) {
        const typeVal = fm[2];
        const nameVal = fm[3];

        if (!INVALID.has(nameVal)) {
          fields.push({ visibility, name: nameVal, type: typeVal });

          // Estrae associazioni "uses"
          const refs = extractReferencedTypes(typeVal);
          refs.forEach(ref => {
            if (ref !== name && ref !== nameVal) {
              relations.push({ kind: 'uses', target: ref });
            }
          });
        }
      }
    });

    // Multiple inheritance & templates
    if (m[3]) {
      m[3].split(',').map(s => s.trim()).filter(Boolean).forEach(parent => {
        const target = parent.replace(/(public|protected|private)\s+/g, '').replace(/<.*>/g, '').trim();
        if (target) relations.push({ kind: 'extends', target });
      });
    }

    classes.push({ name, type, file, fields, methods, relations });
  }

  return classes;
}

// ─────────────────────────────────────────────
//  PLANTUML
// ─────────────────────────────────────────────

function buildPlantUML(classes) {
  const out = ['@startuml'];

  // Styling moderno ed elegante
  out.push('skinparam style strictuml');
  out.push('skinparam classAttributeIconSize 0');
  out.push('skinparam monochrome false');
  out.push('skinparam shadowing false');

  const packages = {};
  const flatClasses = [];

  classes.forEach(c => {
    if (c.package) {
      if (!packages[c.package]) packages[c.package] = [];
      packages[c.package].push(c);
    } else {
      flatClasses.push(c);
    }
  });

  function renderClass(c) {
    const classLines = [];
    const keyword = c.type === 'interface' ? 'interface'
                  : c.type === 'enum' ? 'enum'
                  : 'class';

    classLines.push(`${keyword} ${c.name} {`);

    c.fields.forEach(f => {
      classLines.push(`  ${f.visibility}${f.name} : ${f.type}`);
    });

    if (c.fields.length && c.methods.length) classLines.push('  --');

    c.methods.forEach(m => {
      const ret = m.returnType ? ` : ${m.returnType}` : '';
      classLines.push(`  ${m.visibility}${m.name}(${m.params})${ret}`);
    });

    classLines.push('}');
    return classLines.join('\n');
  }

  // Renderizza classi raggruppate per package
  Object.keys(packages).sort().forEach(pkgName => {
    out.push(`package "${pkgName}" {`);
    packages[pkgName].forEach(c => {
      out.push(renderClass(c));
    });
    out.push('}\n');
  });

  // Renderizza classi flat (senza package)
  flatClasses.forEach(c => {
    out.push(renderClass(c));
  });

  // Relazioni uniche
  const seen = new Set();

  classes.forEach(c => {
    c.relations.forEach(r => {
      const key = `${c.name}-${r.kind}-${r.target}`;
      if (seen.has(key)) return;
      seen.add(key);

      if (r.kind === 'extends') out.push(`${r.target} <|-- ${c.name}`);
      if (r.kind === 'implements') out.push(`${r.target} <|.. ${c.name}`);
      if (r.kind === 'uses') out.push(`${c.name} ..> ${r.target}`);
    });
  });

  out.push('@enduml');
  return out.join('\n');
}

module.exports = { parseJava, parseCCpp, buildPlantUML };