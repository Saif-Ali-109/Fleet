import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const filePath = join(process.cwd(), "src/dashboard/webDashboard.ts");
const content = readFileSync(filePath, "utf8");

// Find the HTML constant: we look for `const HTML = `
const htmlConstMatch = content.match(/const HTML = `([\s\S]*?)`;/);
if (!htmlConstMatch) {
	console.error("HTML constant not found");
	process.exit(1);
}
const fullHTML = htmlConstMatch[1];

// Find the script tag
const scriptTagMatch = fullHTML.match(/<script>[\s\S]*<\/script>/);
if (!scriptTagMatch) {
	console.error("Script tag not found in HTML constant");
	process.exit(1);
}
const scriptTag = scriptTagMatch[0];
const clientJsContent = scriptTag.slice(8, -9); // remove <script> and </script>
const templateHtml = fullHTML.replace(scriptTag, "<!-- INJECT_CLIENT_JS -->");

// Write template.html
writeFileSync(
	join(process.cwd(), "src/dashboard/template.html"),
	templateHtml,
	"utf8",
);

// Write client.js
writeFileSync(
	join(process.cwd(), "src/dashboard/client.js"),
	clientJsContent,
	"utf8",
);

console.log("Extraction complete");
