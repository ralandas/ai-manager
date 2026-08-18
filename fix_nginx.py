import re
import subprocess

path = '/etc/nginx/sites-available/visualmind'
with open(path, 'r') as f:
    content = f.read()

ai_block = """
    # ===== AI Manager: owner API v2 (auth + apartments CRUD) =====
    location ^~ /api/v2 {
        proxy_pass http://127.0.0.1:3020;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 20M;
    }

    location ^~ /api/admin {
        proxy_pass http://127.0.0.1:3020;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ===== AI Manager: apartment photos =====
    location ^~ /photos/ {
        proxy_pass http://127.0.0.1:3020;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 20M;
    }

    location ^~ /apt/ {
        proxy_pass http://127.0.0.1:3020;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
"""

# Remove old block if exists
pattern = r'# ===== AI Manager:[^\n]*.*?location \^~ /apt/[^}]*?\}'
cleaned = re.sub(pattern, '', content, flags=re.DOTALL)

# Insert before 'location ^~ /api/ {'
target = 'location ^~ /api/ {'
if target in cleaned:
    new_content = cleaned.replace(target, ai_block + '\n    ' + target, 1)
    with open(path, 'w') as f:
        f.write(new_content)
    print('Updated visualmind nginx config successfully!')
else:
    print('Target location ^~ /api/ { not found')
