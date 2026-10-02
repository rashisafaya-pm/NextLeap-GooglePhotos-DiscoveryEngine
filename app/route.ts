import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// The landing page is "Insights" -- the top-level overview (intro, stats,
// ranked problem list, methodology) -- a fully self-contained static HTML
// document (public/insights.html), not a React page. The detailed
// quote-browsing experience lives on its own screen at /what-people-say
// (app/what-people-say/route.ts), and the chatbot at /ask.
//
// Route handlers and page components can't share a segment in the App
// Router, so this file replaces what used to be the root page.tsx.
export async function GET() {
  const filePath = path.join(process.cwd(), "public", "insights.html");
  const html = fs.readFileSync(filePath, "utf-8");
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
