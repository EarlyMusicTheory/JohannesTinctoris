#!/usr/bin/env node
/**
 * build-combined.js
 *
 * Turns a pair of plain-text treatise files (the Latin critical edition and its
 * translation) into a `combined.js` file in the format the site's `_layouts/ctw_texts.html`
 * expects, i.e. assignments onto a shared global `texts` object such as:
 *
 *   texts.complexus = {};
 *   texts.complexus.edited = 'first line\n\
 *   second line\n\
 *   ...';
 *   texts.complexus.translation = {};
 *   texts.complexus.translation.english = '...';
 *
 * Written for treatises like "complexus", "proportionale1" and "proportionale23",
 * which only have an edited text and one translation embedded (no per-witness
 * diplomatic transcriptions such as .V / .BU / .Br1 / .G). If it finds *other*
 * data already in an existing combined.js (extra translations, witness texts,
 * commentary, etc.), it leaves that untouched rather than deleting it.
 *
 * Usage:
 *   node scripts/build-combined.js --treatise complexus \
 *     --edited "Tinctoris/texts/complexus/11 Complexus effectuum.txt" \
 *     --translation "Tinctoris/texts/complexus/11 Complexus effectuum (English).txt"
 *
 * Any required value left out on the command line is asked for interactively.
 * Run with --help to see all options.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Step 1: Command-line argument parsing.
// We accept both "--key value" and "--key=value" forms, plus bare boolean
// flags like "--help". Nothing here is required to be a flag -- anything the
// caller doesn't supply, we ask for interactively in main() below.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const eqIndex = token.indexOf('=');
    if (eqIndex !== -1) {
      // "--key=value" form
      args[token.slice(2, eqIndex)] = token.slice(eqIndex + 1);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      // "--key value" form
      args[key] = next;
      i++;
    } else {
      // bare flag, e.g. "--help"
      args[key] = true;
    }
  }
  return args;
}

function printUsage() {
  console.log(`
Usage:
  node scripts/build-combined.js [options]

Required (you'll be prompted for these if you omit them):
  --treatise <slug>          Key used on the site's "texts" object, e.g. "complexus"
                              (must be a valid bare JS property name)
  --edited <path>            Path to the Latin/critical-edition .txt file
  --translation <path>       Path to the translation .txt file

Optional:
  --lang <code>               Translation language key (default: "english")
  --out <path>                 Where to write combined.js
                                (default: same folder as --edited, file "combined.js")
  --date "YYYY-MM-DD[ HH:MM]"  Export timestamp to record (default: now)
  --help                       Show this text
`);
}

// ---------------------------------------------------------------------------
// Step 2: A tiny promise-based wrapper around Node's built-in readline, used
// to interactively ask for anything that wasn't passed as a flag.
// ---------------------------------------------------------------------------
function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question) {
      return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
    },
    close() {
      rl.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Step 3: Validate the treatise slug. It becomes a bare property access
// (texts.<treatise>.edited), so it has to be a legal JS identifier -- the
// same restriction the existing combined.js files all respect ("complexus",
// "proportionale1", "depunctis", ...).
// ---------------------------------------------------------------------------
function validateTreatiseSlug(slug) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(slug)) {
    throw new Error(
      `"${slug}" can't be used as "texts.${slug}...." -- only letters, digits ` +
        `and underscores are allowed, and it can't start with a digit.`
    );
  }
}

// ---------------------------------------------------------------------------
// Step 4: Parse the export date the user gave us (or default to "now" if
// they left it blank). Accepts "YYYY-MM-DD" or "YYYY-MM-DD HH:MM".
// ---------------------------------------------------------------------------
function parseExportDate(input) {
  if (!input) return new Date();

  // Date's constructor wants a "T" separator, not a space, for date+time strings.
  const normalized = input.trim().replace(' ', 'T');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Could not parse "${input}" as a date. Try "YYYY-MM-DD" or "YYYY-MM-DD HH:MM".`);
  }
  return date;
}

// ---------------------------------------------------------------------------
// Step 5: Convert raw .txt content into the site's embedded-string format.
//
// The site stores multi-line text as a single-quoted JS string, using a
// backslash-newline at the end of every line except the last so the string
// literal spans many physical lines in the source file, e.g.:
//
//   'first line\n\
//   second line\n\
//   last line'
//
// That requires:
//   a) escaping characters that are special inside a single-quoted string
//      (backslashes first, so we don't double-escape the ones we add next),
//   b) appending the literal three characters  \  n  \  to the end of every
//      line except the last, which JS reads as "a newline, then keep
//      reading the next source line as part of this same string".
// ---------------------------------------------------------------------------
function toEmbeddedString(rawText) {
  // a) Normalize line endings so *we* control exactly where lines break,
  //    regardless of whether the .txt file used \n or \r\n. Text editors
  //    conventionally save one trailing newline at end-of-file; that's a
  //    file-format nicety, not content, so we drop exactly one before
  //    splitting -- otherwise it shows up as a spurious empty final line
  //    inside the embedded string.
  const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '');
  const lines = normalized.split('\n');

  // b) Escape backslashes and single quotes for safe inclusion inside '...'.
  const escaped = lines.map((line) => line.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));

  // c) Join with the "\n\" continuation marker on every line but the last.
  return escaped
    .map((line, index) => (index === escaped.length - 1 ? line : line + '\\n\\'))
    .join('\n');
}

// Wraps toEmbeddedString's output into a full "texts.X.Y = '...';" statement.
function buildStringAssignment(leftHandSide, rawText) {
  return `${leftHandSide} = '${toEmbeddedString(rawText)}';`;
}

// ---------------------------------------------------------------------------
// Step 6: Parse an *existing* combined.js so we can update it non-destructively.
//
// Every statement we care about starts at column 0 with "texts.<treatise>.".
// A statement is either:
//   - a single line ("texts.x.exportYear = 2024;"), or
//   - a multi-line string using the "\n\" continuation marker described
//     above (ends with a literal trailing backslash until its final line), or
//   - a multi-line array literal like an unfilled-in "sources" list, which
//     stays open (more "[" than "]" so far) across several *real* line breaks
//     without needing a trailing backslash.
//
// We keep consuming lines for a statement until neither condition applies
// any more, which correctly reassembles all three shapes.
// ---------------------------------------------------------------------------
function isBracketBalanced(text) {
  const opens = (text.match(/\[/g) || []).length;
  const closes = (text.match(/\]/g) || []).length;
  return opens <= closes;
}

function parseExistingCombinedJs(content, treatise) {
  const lines = content.split(/\r?\n/);
  const keyPattern = new RegExp('^texts\\.' + treatise + '\\.([A-Za-z0-9_.]+)\\s*=');

  const statements = new Map(); // key -> full raw statement text (verbatim)
  const order = []; // first-seen order, so we can re-emit deterministically

  let i = 0;
  while (i < lines.length) {
    const firstLine = lines[i];
    if (firstLine.trim() === '') {
      i++;
      continue;
    }

    const block = [firstLine];
    while (block[block.length - 1].endsWith('\\') || !isBracketBalanced(block.join('\n'))) {
      i++;
      if (i >= lines.length) break;
      block.push(lines[i]);
    }
    i++;

    const match = firstLine.match(keyPattern);
    if (match) {
      const key = match[1]; // e.g. "edited", "translation.english", "sources", "V"
      if (!statements.has(key)) order.push(key);
      statements.set(key, block.join('\n'));
    }
    // Anything that doesn't match "texts.<treatise>.<key> = ..." is boilerplate
    // ("texts.<treatise> = {};", "if(!texts.treatises)...", "texts.treatises.push(...)")
    // that step 7 always regenerates fresh, so we don't need to keep it here.
  }

  return { statements, order };
}

// ---------------------------------------------------------------------------
// Step 7: Assemble the final combined.js content.
// ---------------------------------------------------------------------------
function buildCombinedJs({ treatise, exportDate, sourcesStatement, editedText, lang, translationText, preserved }) {
  const lines = [];

  // Boilerplate that registers this treatise on the shared "texts" global.
  // Always regenerated identically -- there's nothing file-specific to preserve here.
  lines.push(`texts.${treatise} = {};`);
  lines.push(`if(!texts.treatises) texts.treatises = [];`);
  lines.push(`texts.treatises.push("${treatise}");`);

  // Export timestamp: records when *this* snapshot was produced. viewer.js reads
  // these fields to decide whether a page requesting an older date should fall
  // back to a version stored in previous.js.
  lines.push(`texts.${treatise}.exportYear = ${exportDate.getFullYear()};`);
  lines.push(`texts.${treatise}.exportMonth = ${exportDate.getMonth() + 1};`);
  lines.push(`texts.${treatise}.exportDay = ${exportDate.getDate()};`);
  lines.push(`texts.${treatise}.exportHour = ${exportDate.getHours()};`);
  lines.push(`texts.${treatise}.exportMinutes = ${exportDate.getMinutes()};`);

  // Witness/source list: carried over unchanged from an existing file if there
  // was one (this script doesn't know how to author that list); otherwise we
  // default to an empty array, matching complexus/proportionale1/proportionale23.
  lines.push(sourcesStatement || `texts.${treatise}.sources = [];`);

  // The critical edition text.
  lines.push(buildStringAssignment(`texts.${treatise}.edited`, editedText));

  // The translation container plus the requested language's translation text.
  lines.push(`texts.${treatise}.translation = {};`);
  lines.push(buildStringAssignment(`texts.${treatise}.translation.${lang}`, translationText));

  // Anything else that already existed in the file (other translations,
  // per-witness transcriptions, commentary, ...) gets carried over verbatim.
  for (const raw of preserved) {
    lines.push(raw);
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Step 8: Wire it all together.
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const prompter = createPrompter();
  try {
    // --- Gather required inputs, asking interactively for anything missing. ---
    const treatise = String(args.treatise || (await prompter.ask('Treatise slug (e.g. "complexus"): ')));
    validateTreatiseSlug(treatise);

    const editedPath = String(
      args.edited || (await prompter.ask('Path to the edited/Latin .txt file: '))
    );
    const translationPath = String(
      args.translation || (await prompter.ask('Path to the translation .txt file: '))
    );

    const langAnswer = args.lang || (await prompter.ask('Translation language code [english]: '));
    const lang = String(langAnswer || 'english');

    const defaultOut = path.join(path.dirname(path.resolve(editedPath)), 'combined.js');
    const outAnswer = args.out || (await prompter.ask(`Output combined.js path [${defaultOut}]: `));
    const outPath = path.resolve(String(outAnswer || defaultOut));

    let dateAnswer = args.date;
    if (dateAnswer === undefined) {
      dateAnswer = await prompter.ask('Export date/time as YYYY-MM-DD[ HH:MM] [now]: ');
    }
    const exportDate = parseExportDate(dateAnswer);

    // --- Step 9: Read the source .txt files from disk. ---
    const editedText = fs.readFileSync(editedPath, 'utf8');
    const translationText = fs.readFileSync(translationPath, 'utf8');

    // --- Step 10: If a combined.js already exists at the output path, parse
    // it so we can preserve anything we don't manage, and back it up before
    // we overwrite it. Otherwise we're creating a brand-new file. ---
    let sourcesStatement = null;
    let preserved = [];
    let mode = 'create';

    if (fs.existsSync(outPath)) {
      mode = 'update';
      const existing = fs.readFileSync(outPath, 'utf8');
      const { statements, order } = parseExistingCombinedJs(existing, treatise);

      const managedKeys = new Set([
        'exportYear',
        'exportMonth',
        'exportDay',
        'exportHour',
        'exportMinutes',
        'sources',
        'edited',
        'translation',
        `translation.${lang}`,
      ]);

      if (statements.has('sources')) sourcesStatement = statements.get('sources');
      preserved = order.filter((key) => !managedKeys.has(key)).map((key) => statements.get(key));

      fs.copyFileSync(outPath, `${outPath}.bak`);
    }

    // --- Step 11: Build the new file content and write it out. ---
    const newContent = buildCombinedJs({
      treatise,
      exportDate,
      sourcesStatement,
      editedText,
      lang,
      translationText,
      preserved,
    });

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, newContent, 'utf8');

    // --- Step 12: Report what happened. ---
    console.log(`\n${mode === 'create' ? 'Created' : 'Updated'} ${outPath}`);
    console.log(`  texts.${treatise}.edited              <- ${editedPath}`);
    console.log(`  texts.${treatise}.translation.${lang} <- ${translationPath}`);
    console.log(
      `  export date recorded as ${exportDate.getFullYear()}-${exportDate.getMonth() + 1}-${exportDate.getDate()} ` +
        `${exportDate.getHours()}:${String(exportDate.getMinutes()).padStart(2, '0')}`
    );
    if (mode === 'update') {
      console.log(`  previous file backed up to ${outPath}.bak`);
      if (preserved.length) {
        console.log(`  preserved untouched: ${preserved.map((s) => s.split('=')[0].trim()).join(', ')}`);
      }
    }
  } finally {
    prompter.close();
  }
}

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exitCode = 1;
});
