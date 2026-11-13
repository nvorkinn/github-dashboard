var e={read:async e=>({pull:e,description:e.number===128?`Adds **gust readings** to the wind chart, so that a calm average no longer hides a storm.

## What changed

- \`conversions.ts\` gains \`toGust()\`, the highest reading in each hour
- The chart draws gusts as a dashed line above the average
- [x] Unit tests for the conversion
- [ ] Check it against last winter's data

| Reading | Before | After |
| ------- | ------ | ----- |
| Average | ✓ | ✓ |
| Gusts | | ✓ |

> The sensor reports every 10 seconds, so an hour has 360 readings.

\`\`\`ts
export const toGust = (readings: number[]) => Math.max(...readings);
\`\`\`

See [the sensor's notes](https://example.com/anemometer) for how it samples.

<details>
<summary>Screenshots</summary>

![The wind chart with gusts](https://example.com/gusts.png)

</details>`:`Keeps **${e.title}** small and to the point.`,canApprove:!1,canMerge:!1,reviews:e.number===128?[{user:{login:`monalisa`},state:`COMMENTED`,body:`Looks good. Could the dashed line be a **little** lighter?`}]:[]}),approve:async()=>{}};export{e as demoReview};