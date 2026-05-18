# Chart Output

Render live, interactive charts directly in your messages and on the roster card. The hub parses any `chart` fenced block and replaces it with a real chart — no file needed.

## Inline chart syntax

Wrap a JSON spec in a ` ```chart ``` ` fenced block anywhere in your message:

````
```chart
{
  "type": "bar",
  "title": "Weekly Revenue",
  "x": "week",
  "series": [{ "key": "revenue", "label": "Revenue" }],
  "data": [
    { "week": "W1", "revenue": 12400 },
    { "week": "W2", "revenue": 15800 },
    { "week": "W3", "revenue": 11200 },
    { "week": "W4", "revenue": 18600 }
  ]
}
```
````

You can mix charts with prose — put the block wherever it fits naturally in your response.

## Schema reference

| Field | Required | Description |
|-------|----------|-------------|
| `type` | yes | `"bar"` \| `"line"` \| `"area"` \| `"pie"` \| `"donut"` |
| `title` | no | Heading shown above the chart |
| `description` | no | Subtitle / caption below the title |
| `x` | bar/line/area | The data key used for the x-axis |
| `series` | yes | Array of `{ key, label?, color? }` — one entry per line/bar |
| `data` | yes | Array of objects whose keys match `x` and each `series[].key` |

For **pie** and **donut** each data object must have a `"name"` field plus the value key from `series[0].key`.

## When to use each type

- **bar** — comparing categories or periods side by side (SKU sales, campaign spend)
- **line** — trends over time (daily active users, revenue run rate)
- **area** — same as line but emphasizes volume (cumulative growth, stacked channels)
- **pie** — part-to-whole at a single point (traffic source split, budget allocation)
- **donut** — like pie, cleaner when you have a center callout to imply

## Roster card sparkline

When you call `set_roster_status`, include a `chart` field to display a sparkline on the roster card. Keep it compact — a line or area chart with 5–10 points reads best at that size.

```json
{
  "tone": "ok",
  "summary": "Email revenue up 14% this week.",
  "chart": {
    "type": "area",
    "x": "day",
    "series": [{ "key": "rev", "label": "Revenue" }],
    "data": [
      { "day": "Mon", "rev": 3800 },
      { "day": "Tue", "rev": 4200 },
      { "day": "Wed", "rev": 3900 },
      { "day": "Thu", "rev": 5100 },
      { "day": "Fri", "rev": 4700 }
    ]
  }
}
```

## Output file charts

For charts that should persist beyond the session (e.g. in a report or slideshow), write the spec to a file named `*.chart.json`. The hub previews it as a full-size chart and the file can be opened later.

```python
import json

spec = {
  "type": "bar",
  "title": "Channel Performance — Q2",
  "x": "channel",
  "series": [
    { "key": "revenue", "label": "Revenue" },
    { "key": "orders",  "label": "Orders"  }
  ],
  "data": [
    { "channel": "Email",   "revenue": 84200, "orders": 620 },
    { "channel": "Paid",    "revenue": 61400, "orders": 490 },
    { "channel": "Organic", "revenue": 38700, "orders": 310 }
  ]
}

with open("q2_performance.chart.json", "w") as f:
    json.dump(spec, f)
```

## Examples

### Multi-series bar

```chart
{
  "type": "bar",
  "title": "Revenue by Channel",
  "x": "month",
  "series": [
    { "key": "email",   "label": "Email"   },
    { "key": "paid",    "label": "Paid"    },
    { "key": "organic", "label": "Organic" }
  ],
  "data": [
    { "month": "Feb", "email": 41000, "paid": 28000, "organic": 19000 },
    { "month": "Mar", "email": 48000, "paid": 31000, "organic": 22000 },
    { "month": "Apr", "email": 44000, "paid": 35000, "organic": 25000 },
    { "month": "May", "email": 53000, "paid": 38000, "organic": 29000 }
  ]
}
```

### Line — trend

```chart
{
  "type": "line",
  "title": "Daily Active Users",
  "x": "date",
  "series": [{ "key": "dau", "label": "DAU" }],
  "data": [
    { "date": "5/5", "dau": 8420 },
    { "date": "5/6", "dau": 9100 },
    { "date": "5/7", "dau": 8750 },
    { "date": "5/8", "dau": 10200 },
    { "date": "5/9", "dau": 11400 }
  ]
}
```

### Donut — split

```chart
{
  "type": "donut",
  "title": "Traffic Sources",
  "series": [{ "key": "value" }],
  "data": [
    { "name": "Email",   "value": 42 },
    { "name": "Paid",    "value": 28 },
    { "name": "Organic", "value": 20 },
    { "name": "Direct",  "value": 10 }
  ]
}
```

## Tips

- Aim for 6–20 data points; very dense data is hard to read at chart height
- Use `label` in each series entry so tooltips show human-readable names
- You can use `color` (hex string) on any series to override the default palette
- Charts render at ~225 px tall in chat; the roster sparkline is ~60 px
