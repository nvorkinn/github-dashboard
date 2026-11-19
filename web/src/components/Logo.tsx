/**
 * The dashboard's logo: the favicon itself, so the header, the browser tab, an installed app and notifications all
 * show the same mark. Decorative, since the title beside it names the page.
 */
export function Logo({ size, class: className }: { size: number; class?: string }) {
  return (
    <img
      class={["logo", className].filter(Boolean).join(" ")}
      src={`${import.meta.env.BASE_URL}favicon.svg`}
      alt=""
      width={size}
      height={size}
    />
  );
}
