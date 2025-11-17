# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Climbdex is a Flask-based web application that provides an advanced search engine for interactive climbing training boards (Kilter, Tension, Decoy, Grasshopper, Touchstone). The primary value-add is "filter by hold" functionality and precise difficulty/quality ratings that are not available in the official Aurora Climbing apps.

The app is a Progressive Web App (PWA) that can be installed on any platform. It uses local SQLite databases synced from Aurora's API via the BoardLib Python library.

**Development Focus**: This project is being developed specifically for a Kilter homewall (7x10 fullride). Features are built for this board without maintaining compatibility with other boards (Tension, Decoy, etc.).

## Development Commands

### Initial Setup

Install Python dependencies (venv recommended):
```bash
python3 -m pip install -r requirements.txt
```

### Running the Server

Start the development server:
```bash
gunicorn wsgi:app
```

The app will be available at `http://localhost:8000` (or the port gunicorn selects).

### Database Synchronization

Download/sync a board database before using most features:
```bash
bin/sync_db.sh <board_name>
```

where `<board_name>` is one of: `decoy`, `grasshopper`, `kilter`, `tension`, or `touchstone`.

The sync script creates a `data/<board_name>/db.sqlite` file. These databases are not tracked in git.

## Architecture

### Backend (Python/Flask)

**Entry Point**: `wsgi.py` → `climbdex/__init__.py:create_app()`

The Flask app registers two blueprints:
- `climbdex.api.blueprint` - REST API endpoints (`/api/v1/*`)
- `climbdex.views.blueprint` - Server-side rendered views

**Key Modules**:

- `climbdex/db.py` - Database layer with predefined SQL queries in the `QUERIES` dict. All database access goes through `get_data()`, `get_search_results()`, and `get_search_count()`. Uses SQLite connection stored in `flask.g.database`.

- `climbdex/api.py` - REST API endpoints for:
  - Board metadata (layouts, sizes, sets)
  - Climb search with complex filtering (holds, grades, quality, difficulty accuracy)
  - Authentication via BoardLib (login, save ascents, save climbs)
  - Beta video links

- `climbdex/views.py` - Server-side rendered routes:
  - `/` - Board selection
  - `/filter` - Hold filter selection interface
  - `/results` - Search results with climb listings
  - `/create` - Climb creation interface
  - Serves local board images from `data/<board>/images/`

**Search Query Construction**: The most complex logic is in `db.py:get_search_base_sql_and_binds()`, which dynamically builds SQL queries based on filter parameters including:
- Hold sequences (with mirroring support)
- Role matching (strict/any/hands-only)
- Grade ranges and difficulty accuracy
- Quality ratings
- Ascent counts
- Setter names

### Frontend (Vanilla JavaScript + Jinja2 Templates)

**Templates** (`climbdex/templates/`):
- `boardSelection.html.j2` - Board picker
- `filterSelection.html.j2` - Hold selection interface with SVG board
- `results.html.j2` - Search results with climb cards
- `climbCreation.html.j2` - Climb creation UI
- `beta.html.j2` - Beta video links

**JavaScript** (`climbdex/static/js/`):
- `common.js` - Core `drawBoard()` function that renders SVG board with clickable holds
- `filterSelection.js` - Hold filter logic (click cycling through colors, reset, grade slider)
- `results.js` - Results page interactivity (climb cards, logbook integration)
- `climbCreation.js` - Climb creation interface
- `bluetooth.js` - Board Bluetooth LED control
- `nouislider.min.js` - Third-party grade slider library

**Board Rendering**: Holds are rendered as SVG circles over board images. The `drawBoard()` function:
1. Takes board dimensions (`edgeLeft`, `edgeRight`, `edgeBottom`, `edgeTop`)
2. Loads board images and overlays clickable circles at hold positions
3. Circles have IDs like `hold-{holdId}` and optional `data-mirror-id` for mirrored boards
4. Click handlers are passed in to handle hold selection/coloring

### Data Model

**Hold Encoding**: Climbs store holds as frame strings like `p123r2p456r1` where:
- `p{placement_id}` identifies a hold
- `r{role_id}` identifies the color/type (start, middle, finish, foot)

**Mirroring**: Layouts can be mirrored. The `placements` table includes `mirrored_hole_id` to map holds to their mirror equivalents. Search queries include both normal and mirrored hold sequences when the layout supports it.

**Difficulty Accuracy**: Climbs have both `display_difficulty` (consensus grade) and `difficulty_average` (raw average). The `gradeAccuracy` filter uses the difference to find "benchmark" climbs.

## Important Patterns

### Database Connections
- Always access via `get_board_database(board_name)` which caches in `flask.g`
- Queries use named parameters (`:param` or `$param` syntax)

### Board-Specific Queries
- Most queries need `layout_id`, `size_id`, and/or `set_id` parameters
- Use `get_data(board_name, query_name, binds={})` for predefined queries

### Frontend-Backend Contract
- Query params drive state (bookmarkable filters)
- Board metadata fetched via API calls to `/api/v1/<board>/layouts`, `/sizes`, `/sets`
- Search uses `/api/v1/search` with query params for all filters

### Authentication
- Login via BoardLib returns token + user_id stored in cookies as `{board}_login`
- Token required for save_ascent and save_climb endpoints
- Logbook data fetched from Aurora API, aggregated in `views.py:get_bids()`

## Deployment

The app is deployed on Fly.io (configured in `fly.toml`). The Procfile specifies `gunicorn wsgi:app` as the web process.
