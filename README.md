# Diagramix

Diagramix is a lightweight analyzer for **Java and C++** projects.
Upload a `.zip` or paste a public GitHub repository URL and get:

- **UML Blocks** (readable cards for classes/interfaces/enums/structs)
- **PlantUML source** (downloadable per class / package / directory / full project)
- **SVG/PNG previews** rendered via a backend proxy to Kroki (avoids 414 URL-length issues)

This repo includes **backend** (Node.js/Express) + **frontend** (HTML/CSS/JS).

## Prerequisites

- **Node.js** (recommended: LTS) and **npm**
- **Git** (Only if you want to analyze public GitHub repositories)

## Install

```bash
npm install
```

## Run
```bash
node server.js
```

## Website
Diagramix is also available online at [diagramix.onrender.com](https://diagramix.onrender.com/)).
Ps. The server will spend few seconds for the initial set up.

