# Versioning — Session Reporter VS Code Extension

## Règle absolue

**À CHAQUE modification du code source (`src/extension.ts`), la version dans `package.json` DOIT être incrémentée AVANT de packager.**

Ne pas respecter cette règle casse le mécanisme d'auto-update de l'extension (le numéro de version sert à détecter les mises à jour côté client).

## Procédure complète de release

```bash
# 1. Modifier le code dans src/extension.ts

# 2. Incrémenter la version dans package.json
code package.json   # Modifier "version": "0.X.Y"

# 3. Compiler et packager
npm run compile     # Vérifie que le TS compile
npm run package     # Produit session-reporter-0.X.Y.vsix

# 4. Commiter avec le bon message
git add package.json out/ session-reporter-0.X.Y.vsix
git commit -m "chore: bump version to 0.X.Y"

# 5. Taguer
git tag -a v0.X.Y -m "Description des changements"
git push origin master --tags

# 6. Créer la release GitHub (obligatoire pour l'auto-update)
gh release create v0.X.Y \
  --title "v0.X.Y — Description" \
  --notes "- Changement 1\n- Changement 2\n- Fix #123" \
  session-reporter-0.X.Y.vsix
```

## Convention sémantique

| Version | Quand |
|---------|-------|
| **Patch** (0.8.1 → 0.8.2) | Correction de bug, log, refactor sans changement de comportement |
| **Minor** (0.8.0 → 0.9.0) | Nouvelle fonctionnalité, changement d'API endpoint, nouveau paramètre |
| **Major** (1.0.0 → 2.0.0) | Breaking change, refonte complète |

## Auto-update

L'extension vérifie les mises à jour via les releases GitHub. Le mécanisme compare le tag de la release (`v0.X.Y`) avec la version locale (`package.json`). Si la release est plus récente, le VSIX est téléchargé et installé automatiquement (si `sessionReporter.autoUpdate: true`).

## Fichiers à versionner

Le VSIX (`session-reporter-0.X.Y.vsix`) est commité dans le repo — il sert de source directe pour les installations manuelles et l'auto-update.
