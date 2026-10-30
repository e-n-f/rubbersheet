# rubbersheet

A static site with no build step: `index.html`, `style.css` and ES modules in `js/`. Tests run with `node --test test/warp.test.mjs`.

## Try-it links

Link to a version of the site by its commit, not its branch: raw.githack.com caches branch URLs, so a branch link can serve stale files after a push, while a commit's files never change.

    https://raw.githack.com/e-n-f/rubbersheet/<sha>/index.html

with `<sha>` the short hash of the commit to try (`git rev-parse --short HEAD` after pushing). A map view can follow as `#zoom/lat/lng`, for example `https://raw.githack.com/e-n-f/rubbersheet/ff9e57c/index.html#10.88/37.8232/-122.2511`. Use this form whenever giving a link to try a change, in chat as well as in PRs.

## Pull requests

Start every PR description with a link for trying the PR's head commit:

    **Try it:** https://raw.githack.com/e-n-f/rubbersheet/<sha>/index.html

When you push more commits to the PR, update the link to the new head.
