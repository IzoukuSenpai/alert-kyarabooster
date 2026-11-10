# Kyara Boosters

Extension Firefox non officielle qui suit le stock de boosters gratuits de [kyara.games](https://kyara.games) et prévient quand il approche du maximum, uniquement après avoir relu le vrai chiffre sur le site.

## Fonctionnement

- Le badge de l'icône affiche le stock : vert = lu récemment, gris = estimation par minuteur, orange = seuil atteint et confirmé.
- Entre deux lectures, le stock est estimé localement, sans aucune requête.
- Quand l'estimation atteint le seuil, l'extension relit `GET /api/me` avec la session déjà ouverte dans Firefox. Elle ne notifie que si le site confirme. Si des boosters ont été ouverts ailleurs (téléphone), elle se recale en silence.
- Une seule notification par remplissage. Elle est réarmée quand le stock repasse sous le seuil.
- Aucune requête ni alerte quand le PC est inactif (2 min sans clavier ni souris) : la vérification se fait au retour.
- Pas de notification si kyara.games est l'onglet affiché.
- Le seuil se règle dans le popup (18 par défaut).

## Charge sur le site

Une lecture à chaque passage estimé du seuil, puis une toutes les 30 minutes tant que le stock reste au seuil, jamais plus d'une toutes les 5 minutes en automatique, et pause de 15 minutes après une erreur. L'en-tête `x-kyara-rush` du site (demande de ralentir) allonge ces délais.

## Session

Le site garde sa session dans le `localStorage` (`kyara_token`). Le script de contenu la transmet au script de fond, qui la conserve dans le stockage de l'extension et ne l'envoie qu'à `https://kyara.games/api/me`. Rien d'autre ne sort de l'extension. Si la session expire, le badge affiche `!` : il suffit de rouvrir le site.

## Installation (temporaire)

1. Ouvrir `about:debugging#/runtime/this-firefox` dans Firefox.
2. Cliquer sur « Charger un module complémentaire temporaire… ».
3. Choisir le fichier `manifest.json` de ce dossier.
4. Ouvrir kyara.games (connecté) une fois : le badge affiche le stock.

Un module temporaire disparaît à la fermeture de Firefox. Pour une installation permanente, il faut le faire signer par Mozilla (`web-ext sign`, canal non listé).

## Tests

```bash
node test.js
```
