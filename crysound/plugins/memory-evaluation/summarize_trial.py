#!/usr/bin/env python3
"""Extract memory-only evidence from explicitly selected synthetic trial sessions (zstd CLI required)."""
import argparse
import json
from pathlib import Path
import subprocess


def summarize(path):
    rows = [json.loads(line) for line in subprocess.check_output(["zstd", "-dc", str(path)]).decode().splitlines()]
    result = {"session": rows[0]["id"], "createdAt": rows[0]["createdAt"], "modelCalls": [], "memoryTools": [], "recall": []}
    for row in rows:
        data = row.get("data", {})
        message = data.get("message", {})
        if row["type"] == "assistant/message":
            source = message.get("source", {})
            result["modelCalls"].append({"seq": row["seq"], "provider": source.get("provider"), "model": source.get("model"), "usage": data.get("usage", {})})
        if row["type"] == "tool/call" and "memory" in data["name"]:
            result["memoryTools"].append({"seq": row["seq"], "name": data["name"], "arguments": json.loads(data["arguments"])})
        if row["type"] == "user/message" and data.get("source", {}).get("kind") == "plugin:dsh-memory-palace":
            result["recall"].append({"seq": row["seq"], "source": "palace", "text": "\n".join(c.get("text", "") for c in data.get("content", []))})
        if row["type"] == "system/message":
            for content in message.get("content", []):
                text = content.get("text", "")
                marker = "当前记忆：\n"
                if marker in text:
                    memory, _ = json.JSONDecoder().raw_decode(text.split(marker, 1)[1])
                    result["recall"].append({"seq": row["seq"], "source": "crysound-memory", "chars": len(json.dumps(memory, ensure_ascii=False, separators=(",", ":"))), "snapshot": memory})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("sessions", type=Path, nargs="+")
    args = parser.parse_args()
    result = {"scope": "Synthetic memory trials only. Main-model calls exclude title generation and palace background summaries. Token fields are host-reported, not billing measurements. Character counts are Unicode code points (not JS UTF-16 or tokens).", "sessions": [summarize(p) for p in args.sessions]}
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
