// The console's Home and About copy (installations plan, P3, slice 3): an
// installation's Markdown renders with the same elements, classes and layout
// as the built-in content. The fixtures are the Graffiticode profile's copy
// as /api/config serves it (copy.consoleHome, copy.consoleAbout), so the
// rendered output is what production would show with that profile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import InstallationCopy from "../components/InstallationCopy";
import { HomeBuiltIn, homeMarkdownComponents, HOME_BODY, HOME_HEADING, HOME_LINK } from "../components/HomeCopy";
import { AboutBuiltIn, aboutMarkdownComponents } from "../components/AboutCopy";

// The console compiles JSX with Next (tsconfig "jsx": "preserve"); under tsx
// the components use the classic runtime, which reads a global React.
(globalThis as any).React = React;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/installation-copy/${name}`, import.meta.url), "utf8");

const render = (markdown: string | null, components: any, builtIn: any) =>
  renderToStaticMarkup(createElement(InstallationCopy, { markdown, components }, builtIn));

// Each opening tag, with its class and (for site links) its path: the
// structure and styling, without the text.
function skeleton(html: string) {
  const out: string[] = [];
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)([^>]*)>/g)) {
    const [, tag, attrs] = m;
    if (tag === "path") continue;
    const cls = /\sclass="([^"]*)"/.exec(attrs)?.[1]?.replace(/&amp;/g, "&");
    const href = /\shref="([^"]*)"/.exec(attrs)?.[1];
    out.push(`${tag}${cls ? `.${cls.split(/\s+/).join(".")}` : ""}${href ? `[${href.startsWith("/") ? href : href.split(":")[0]}]` : ""}`);
  }
  return out;
}

test("Home: the profile's Markdown renders as the built-in heading, body and links, with no wrapper", () => {
  const html = render(fixture("console-home.md"), homeMarkdownComponents, null);
  assert.ok(!html.includes("prose"), "no typography plugin styles");
  const body = `p.${HOME_BODY.split(" ").join(".")}.[p+&]:mt-1`;
  const link = (path: string) => `a.${HOME_LINK.split(" ").join(".")}[${path}]`;
  assert.deepEqual(skeleton(html), [
    `h1.${HOME_HEADING.split(" ").join(".")}`,
    body, link("/support"), link("/tools"),
    body,
  ]);
  // The built-in content has the same heading, body and link classes.
  const builtIn = render(null, homeMarkdownComponents, createElement(HomeBuiltIn, { signedIn: false }));
  assert.deepEqual(skeleton(builtIn), [
    `h1.${HOME_HEADING.split(" ").join(".")}`,
    `p.${HOME_BODY.split(" ").join(".")}`, link("/support"), link("/tools"), "br", "br",
  ]);
  // The rendered text is the built-in text.
  const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  assert.equal(text(html), text(builtIn));
});

test("Home: a paragraph after another adds 0.25rem to the column's 1rem gap, the built-in blank line", () => {
  const html = render(fixture("console-home.md"), homeMarkdownComponents, null);
  // The variant applies only to a paragraph that follows a paragraph.
  assert.equal((html.match(/\[p\+&amp;\]:mt-1/g) ?? []).length, 2);
  assert.match(html, /^<h1 /, "the heading is the first element in the page's column");
});

test("About: the profile's Markdown renders element for element as the built-in page, callout included", () => {
  const html = render(fixture("console-about.md"), aboutMarkdownComponents, null);
  const builtIn = render(null, aboutMarkdownComponents, createElement(AboutBuiltIn));
  assert.ok(!html.includes("prose"), "no typography plugin styles");
  assert.ok(!html.includes("<blockquote"), "the callout, not a blockquote");
  assert.deepEqual(skeleton(html), skeleton(builtIn));
  // The callout: its icon, and the lead-in in font-medium directly in its column.
  assert.match(html, /<div class="col-span-11 pr-4 font-light">\s*<span class="font-medium">What(&#x27;|')s missing\?<\/span>/);
  assert.match(html, /<a href="mailto:[^"]*"><b>Send us a note!<\/b><\/a>/);
});

test("About: headings, inline styles and site links match the built-in page's", () => {
  const html = render(fixture("console-about.md"), aboutMarkdownComponents, null);
  const tags = skeleton(html);
  assert.deepEqual(tags.filter(t => t.startsWith("h")), ["h2.font-semibold", "h2.font-semibold", "h2.font-semibold", "h2.font-semibold"]);
  assert.deepEqual(tags.filter(t => t.startsWith("a")), ["a[/tools]", "a[mailto]", "a[/items]", "a[/tasks]"]);
  assert.ok(!/<strong|<em/.test(html), "**strong** and *em* are <b> and <i>, as built in");
});

test("without a profile, the built-in content renders unchanged", () => {
  const about = render(null, aboutMarkdownComponents, createElement(AboutBuiltIn));
  assert.equal(about, renderToStaticMarkup(createElement(AboutBuiltIn)));
  const home = render(null, homeMarkdownComponents, createElement(HomeBuiltIn, { signedIn: true }));
  assert.ok(!home.includes("New here?"), "signed in, the built-in Home leaves out the sign-up note");
});
