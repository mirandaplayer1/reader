#!/usr/bin/env python3
"""Assemble the Reader app from src/.

Outputs:
  build/artifact.html  body-only page for publishing as a Claude artifact
  index.html           the same app as a standalone page for any static host
"""
import json
import pathlib

root = pathlib.Path(__file__).parent
src = root / "src"
app = (src / "app.html").read_text(encoding="utf-8")
chapters = json.loads((src / "chapters.json").read_text(encoding="utf-8"))

page = (
    app.replace("/*__DATA__*/", (src / "data.js").read_text(encoding="utf-8"))
    .replace("/*__CH__*/[]", json.dumps(chapters, ensure_ascii=False))
    .replace("__THUMB__", (src / "thumb.txt").read_text().strip())
)

(root / "build").mkdir(exist_ok=True)
(root / "build" / "artifact.html").write_text(page, encoding="utf-8")
(root / "index.html").write_text(
    '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    "</head><body>" + page + "</body></html>\n",
    encoding="utf-8",
)
print("built", len(page), "bytes,", len(chapters), "chapters")
