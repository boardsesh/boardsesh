#!/usr/bin/env python3
"""Update resolver files to use ctx.db instead of imported singleton db."""

import re
import sys
from pathlib import Path

REQUEST_DB_IMPORT = "import type { RequestDbInstance } from '@boardsesh/db/client';"

def update_file(filepath: Path) -> bool:
    content = filepath.read_text()
    
    # Skip if no db usage
    if 'await db.' not in content and '= await db' not in content and '.execute(' not in content:
        return False
    
    modified = False
    
    # 1. Remove singleton db import (keep other imports from same source)
    content = re.sub(r"import \{ db \} from '.*?db/client';\n?", '', content)
    content = re.sub(r'import \{ db \} from "@boardsesh/db/client";\n?', '', content)
    modified = True
    
    # 2. Add RequestDbInstance import after first import (if not present)
    if 'RequestDbInstance' not in content:
        # Find first import and insert after it
        first_import_match = re.search(r"(^import .+?\n)", content, re.MULTILINE)
        if first_import_match:
            insert_pos = first_import_match.end()
            content = content[:insert_pos] + REQUEST_DB_IMPORT + '\n' + content[insert_pos:]
            modified = True
    
    # 3. Add const db = ctx.db as RequestDbInstance; after ctx parameter
    # Handle arrow functions: (_, __, ctx) => {
    # Handle regular functions: (_, __, ctx) => {
    pattern = r"((?:_[^,]*,\s*){2,}(?:ctx|context):\s*ConnectionContext[^)]*\))\s*(=>\s*\{|:\s*[A-Za-z<>]+\s*=>\s*\{)"
    
    def add_db_const(match):
        func_sig = match.group(1)
        func_body = match.group(2)
        return f"{func_sig}\n  {{ const db = ctx.db as RequestDbInstance; {func_body}"
    
    new_content = re.sub(pattern, add_db_const, content)
    if new_content != content:
        content = new_content
        modified = True
    
    if modified:
        filepath.write_text(content)
    
    return modified

def main():
    resolver_dir = Path("packages/backend/src/graphql/resolvers")
    
    files_updated = 0
    for filepath in resolver_dir.rglob("*.ts"):
        try:
            if update_file(filepath):
                print(f"Updated: {filepath}")
                files_updated += 1
        except Exception as e:
            print(f"Error in {filepath}: {e}")
    
    print(f"\nTotal files updated: {files_updated}")

if __name__ == "__main__":
    main()
