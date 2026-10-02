import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// The quote-browsing screen -- click a ranked cluster, read representative
// quotes and individual threads, filter by severity/cue type. Split out of
// the old single-page Atlas so the landing page ("Insights") can stay a
// lightweight overview while this page carries the full embedded dataset
// (all 365 episodes). Static HTML (public/what-people-say.html), served
// the same way as the root route.
export async function GET() {
  const filePath = path.join(process.cwd(), "public", "what-people-say.html");
  const html = fs.readFileSync(filePath, "utf-8");
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
