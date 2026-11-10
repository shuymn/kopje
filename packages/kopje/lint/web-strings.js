// docs/web-pages.md, "English UI, ready for translation": the web UI's text comes from the catalogue
// (src/web/strings.ts) through useUi(), so a page can be translated. No component or page writes words itself: no
// letters in JSX text, in a string a JSX child renders, or in a literal aria-label, title, alt, placeholder or label.
// The root .oxlintrc.json turns this rule on for the pages and components, the setup wizard (not catalogued) left out.
const NAMED_ATTRIBUTES = new Set(["aria-label", "title", "alt", "placeholder", "label"]);
const LETTER = /\p{L}/u;

// The words a string-valued expression may render: a literal, a template's text, either branch of a condition and the
// right side of && or ||.
function words(node) {
  switch (node?.type) {
    case "Literal":
      return typeof node.value === "string" && LETTER.test(node.value) ? [node.value] : [];
    case "TemplateLiteral":
      return node.quasis.map((q) => q.value.cooked ?? "").filter((text) => LETTER.test(text));
    case "ConditionalExpression":
      return [...words(node.consequent), ...words(node.alternate)];
    case "LogicalExpression":
      return words(node.right);
    default:
      return [];
  }
}

export const webStrings = {
  create(context) {
    const report = (node, what, text) => context.report({ node, message: `${what} ${JSON.stringify(text)}` });
    return {
      JSXText(node) {
        if (LETTER.test(node.value)) {
          report(node, "text", node.value.trim());
        }
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || !NAMED_ATTRIBUTES.has(node.name.name)) {
          return;
        }
        const value = node.value?.type === "JSXExpressionContainer" ? node.value.expression : node.value;
        for (const text of words(value)) {
          report(node, node.name.name, text);
        }
      },
      JSXExpressionContainer(node) {
        if (node.parent.type === "JSXElement" || node.parent.type === "JSXFragment") {
          for (const text of words(node.expression)) {
            report(node, "child", text);
          }
        }
      },
    };
  },
};
