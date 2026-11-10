# Matchday — Combined Recommended Picks update

This package contains the complete replacement homepage and daily picks builder for
`irujeffrey/matchday-picks`.

## What changes
- Football and basketball recommendations appear together on the same homepage.
- Users can view All Sports, Football, or Basketball using filters on that same page.
- Combined recommendations are ordered by kickoff time.
- Football values are labelled as API predictions.
- Basketball values are labelled as experimental model estimates, not calibrated probabilities.
- Each sport keeps its own 60% eligibility threshold; the system does not force picks.
- Existing daily GitHub Actions deployment schedule is retained.

## Files in this package
- `site/index.html` — replace the existing homepage.
- `scripts/build-picks.mjs` — replace the existing daily data builder.
- `.github/workflows/daily-picks.yml` — workflow file (same schedule and deployment approach).

## Install
1. Download and extract this ZIP.
2. In your GitHub repository `irujeffrey/matchday-picks`, replace the matching files with these versions.
3. Keep your existing repository secrets:
   - `APIFOOTBALL_KEY`
   - `API_NINJAS_KEY`
4. Commit the changes to the branch used by GitHub Pages.
5. Open **Actions** in GitHub and run **Build daily football and basketball picks** using **Run workflow**.
6. When the workflow succeeds, open the Pages website and refresh.

## Important notes
- The current builder still requests API-Football predictions for at most 20 scheduled fixtures per day.
- The daily slate continues to use Europe/London date boundaries, matching the existing project.
- Basketball confidence is an experimental estimate based on current-season win rates and home advantage. It should not be marketed as a calibrated probability.
- The API Ninjas plan's licensing/commercial-use terms should be checked before monetizing the site.
- This ZIP is a source-code export; it does not itself change the GitHub repository or deploy the website.
