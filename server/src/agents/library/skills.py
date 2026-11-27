"""Session-local stdio MCP reader for Codex. The catalog contains only this launch's grants."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CATALOG = json.loads((ROOT / "catalog.json").read_text())


def handle(method, params):
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion", "2025-03-26"),
                "capabilities": {"tools": {}}, "serverInfo": {"name": "supermux-skills", "version": "1"},
                "instructions": "Use the matching skill to load its SKILL.md. Read supporting files when its instructions call for them."}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [{"name": name, "description": skill["description"],
                           "inputSchema": {"type": "object", "properties": {
                               "file": {"type": "string", "description": "Markdown path within the skill. Defaults to SKILL.md."}},
                               "additionalProperties": False}}
                          for name, skill in CATALOG.items()]}
    if method == "tools/call":
        name = params["name"]
        file = params.get("arguments", {}).get("file", "SKILL.md")
        if name not in CATALOG or file not in CATALOG[name]["files"] or not file.lower().endswith(".md"):
            return {"isError": True, "content": [{"type": "text", "text": "Unknown skill or Markdown file"}]}
        folder = ROOT / ".claude" / "skills" / name
        content = (folder / file).read_text()
        return {"content": [{"type": "text", "text": f"Skill directory: {folder}\n\n{content}"}]}
    raise KeyError(method)


for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        if "id" not in request:
            continue
        result = {"result": handle(request["method"], request.get("params", {}))}
    except (KeyError, ValueError, TypeError, AttributeError, OSError):
        result = {"error": {"code": -32602, "message": "Unknown method or invalid request"}}
    print(json.dumps({"jsonrpc": "2.0", "id": request.get("id"), **result}), flush=True)
