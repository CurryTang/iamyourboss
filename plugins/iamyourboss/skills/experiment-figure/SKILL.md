---
name: experiment-figure
description: Create an advisor-ready, self-contained HTML figure for experiment trends, distributions, uncertainty, resource curves, or multi-condition comparisons.
---

# Experiment figure

Create one `.html` artifact in the current workspace and return its path. Prefer inline SVG for the chart and include an accessible exact-value table below it. Inline JavaScript is allowed only for small interactions such as toggling series or reading a point.

Choose the visual form from the claim: line for ordered trends, dot/error-bar for estimates, bars for a small categorical comparison, and scatter for relationships. Label axes and units, show uncertainty and seed count when available, identify the baseline, and avoid truncated or dual axes unless the artifact explains why they are necessary.

The file must be fully offline: inline CSS/SVG/data only, with no external libraries, fonts, images, CDNs, or network requests. Keep the headline as the empirical takeaway rather than a generic chart title. Attach the HTML through `$advisor-report`; artifact creation alone is not an advisor update.
