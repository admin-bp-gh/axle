// Standalone check of the deMarkdown strip (verbatim copy of sprocket.js deMarkdown) — used
// because the sandbox file-mount truncates the edited sprocket.js, so the main harness can't
// require it here. The deployed file is validated by node --check on the box at promote time.
function deMarkdown(s) {
  return String(s || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ");
}
let pass = 0, fail = 0;
const eq = (got, want, name) => { if (got === want) pass++; else { fail++; console.log(`  FAIL ${name}: got ${JSON.stringify(got)}`); } };
eq(deMarkdown("use **New email** to draft"), "use New email to draft", "bold");
eq(deMarkdown("help you *write* a chase email"), "help you write a chase email", "italic");
eq(deMarkdown("open the `SAP documents` card"), "open the SAP documents card", "code");
eq(deMarkdown("# Heading\nbody"), "Heading\nbody", "heading");
eq(deMarkdown("2 * 3 = 6 and a*b"), "2 * 3 = 6 and a*b", "bare-star-untouched");
eq(deMarkdown("- step one\n- step two"), "• step one\n• step two", "bullets");
eq(deMarkdown("**Bold** then `code` then *em*"), "Bold then code then em", "mixed");
console.log(`check-demarkdown: ${pass}/${pass + fail} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
