import os
import re

root_dir = '/Users/marcodejongh/Projects/Github/boardsesh/analyse_history_sql/packages/backend/src'
target_package = '@boardsesh/db/client'

def update_imports():
    for root, dirs, files in os.walk(root_dir):
        for file in files:
            if file.endswith('.ts') or file.endswith('.tsx'):
                file_path = os.path.join(root, file)
                
                # Skip the local db/client.ts itself for this kind of replacement
                # although it might need its own specific update if it imports from @boardsesh/db/client
                # But we handled that manually.
                if file_path == os.path.join(root_dir, 'db/client.ts'):
                    continue

                with open(file_path, 'r') as f:
                    content = f.read()

                if target_package in content:
                    # Calculate relative path depth
                    rel_dir = os.path.relpath(root, root_dir)
                    if rel_dir == '.':
                        depth = 0
                    else:
                        depth = rel_dir.count(os.sep) + 1
                    
                    rel_path = '../' * depth + 'db/client'
                    if depth == 0:
                        rel_path = './db/client'
                    
                    # Replace imports
                    # Handle both 'import ... from "@boardsesh/db/client"' and 'import type ... from "@boardsesh/db/client"'
                    # and also vi.mock('@boardsesh/db/client', ...)
                    new_content = content.replace(f"'{target_package}'", f"'{rel_path}'")
                    new_content = new_content.replace(f'"{target_package}"', f'"{rel_path}"')
                    
                    if new_content != content:
                        with open(file_path, 'w') as f:
                            f.write(new_content)
                        print(f"Updated {file_path} with rel_path: {rel_path}")

if __name__ == "__main__":
    update_imports()
