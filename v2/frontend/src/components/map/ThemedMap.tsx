import { Map, type MapProps } from "@vis.gl/react-google-maps";
import { useTheme } from "@/lib/theme";

/** Google's map in the theme's colours. A live map cannot change its colour scheme, so the theme is its key: the
 *  switch draws the map again (back at its starting view). */
export function ThemedMap(props: MapProps) {
  const theme = useTheme();
  return <Map key={theme} colorScheme={theme === "dark" ? "DARK" : "LIGHT"} {...props} />;
}
