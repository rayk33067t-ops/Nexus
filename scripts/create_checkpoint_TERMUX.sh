#!/data/data/com.termux/files/usr/bin/bash
set -e
pwd
if [ ! -d ".git" ]; then git init; git config user.email "kevin@nexus.local"; git config user.name "Kevin Albert"; fi
if git show-ref --verify --quiet refs/heads/phase3-verified-readonly-orb; then git checkout phase3-verified-readonly-orb; else git checkout -b phase3-verified-readonly-orb; fi
cat > .gitignore << 'GI'
*.db
*.db-shm
*.db-wal
*.sqlite
node_modules/
.env
*.key
*.secret
*_1.db
*.broken.backup.ts
output.generated.ts
hhhgyu8
GI
git add . --all
git status --short | head -20
if ! git diff --cached --quiet; then git commit -m "NEXUS v0.1 Phase3 Verified 49/49 PASS - Genesis duplicate fix - Founder Kevin Albert"; fi
if ! git show-ref --verify --quiet refs/tags/v0.1-phase3-ready-for-review; then git tag -a v0.1-phase3-ready-for-review -m "NEXUS v0.1 49/49 PASS - Ready for Founder Review"; fi
echo "--- COMMIT HASH ---"
git rev-parse HEAD
git branch --show-current
git log --oneline -3
git tag -l | grep v0.1
echo "--- FILES IN CHECKPOINT ---"
git ls-tree -r HEAD --name-only | grep -E "chronicle|orb|agents|src/genesis/storage|src/genesis/logic|src/genesis/core" | head -30
