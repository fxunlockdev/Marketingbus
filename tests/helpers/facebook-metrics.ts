export const facebookInsightRows = (id: string) => ({ data: ["post_media_view", "post_total_media_view_unique", "post_clicks", "post_reactions_by_type_total"].map((name, i) => ({
  id: `${id}/insights/${name}/lifetime`, name, period: "lifetime", values: [{ value: [1200, 800, 0, { like: 12, love: 3, wow: 0 }][i] }],
})) });
