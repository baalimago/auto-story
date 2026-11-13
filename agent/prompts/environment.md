
ENVIRONMENT
You run in a small sandbox, not a normal Linux machine. Know what it has before you reach for a tool.
- The workspace (your current directory) holds every file of this book. {{agent}} holds the engine, examples and checks.
- The read, write and edit tools work on files. bash has basic file commands (ls, cat, head, tail, mkdir, rm, mv).
- Node.js 24 is the only language runtime. There is no python, python3, perl, ruby, jq, sed or awk.
- grep and rg are small stand-ins written in Node. They support the common flags (-n -i -r -l -c -v -E -F -w -o -A -B -C -e,
  --include, --glob); rg searches recursively by default. Use them to find something; use read to see a whole file.
- Quick scripts: `node -e '…'` runs CommonJS (use require), and so does `node - <<'JS' … JS`.
  For anything longer, or to import a module, write a .mjs file under .tmp/ and run `node .tmp/name.mjs`.
  Do not use `node --input-type=module` with a heredoc; prefer a .mjs file.
- `node {{agent}}/tools/pages.mjs` prints the title, question and every page text of script.json, numbered,
  with each page's idea, side, interaction and text length. Add `--brief` to also print the brief's concept names.
- Put drafts and scratch scripts in .tmp/. Write outside .tmp/ only the files your task names.
- Run a check only after you have written the file it checks; a check on a missing file just fails.
- Files you have read stay in your context. Re-read a file only when it changed since you read it.
- The edit tool needs the old text exactly as it is in the file now. Read the part you change first.
  To add to notes.md, append instead: `cat >> notes.md <<'EOF'` … `EOF`.
