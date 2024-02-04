import * as cheerio from "cheerio";
import { Logger } from "tslog";
import z from "zod";
import { getCode, getName } from "../../../lib/lang";
import { Node } from "../../../lib/node";
import { Subtitle, RatedSubtitle } from "../../../lib/types";

const baseUrls = ["https://yts-subs.org", "https://yifysubtitles.ch"];

const logger = new Logger({
  name: "imdb",
  type: "pretty",
  hideLogPositionForProduction: true,
});

const imdbSchema = z.string().regex(/tt\d{7}/);
const querySchema = z.object({
  rating: z.coerce.number().optional(),
  lang: z.string().optional(),
});

type Query = z.infer<typeof querySchema>;

export default defineEventHandler(async (event) => {
  const node = new Node(event);
  const rawQuery: Query = getQuery(event);
  let query: Query;

  try {
    query = querySchema.parse(rawQuery);
  } catch (error) {
    logger.error(`${error.message}`);
    const zodError = JSON.parse(error.message)[0];

    return node.prepareResponse({
      status: 400,
      error: "Bad Request",
      message: `Error parsing ${zodError.path[0]}: ${zodError.message}`,
    });
  }

  const imdb = getRouterParam(event, "imdb");
  try {
    imdbSchema.parse(imdb);
  } catch (error) {
    logger.error(`${error.message}`);

    return node.prepareResponse({
      status: 400,
      error: "Bad Request",
      message: "Invalid IMDB ID",
    });
  }

  const chosenBaseUrl = baseUrls[Math.floor(Math.random() * baseUrls.length)];
  const url = `${chosenBaseUrl}/movie-imdb/${imdb}`;
  const yifyPage = await fetch(url);

  const $ = cheerio.load(await yifyPage.text());
  const subtitleLinks = $("tbody").find("tr");
  if (!subtitleLinks.length || subtitleLinks.length === 0) {
    logger.warn(`No subtitles found for ${imdb}`);

    return node.prepareResponse({
      status: 404,
      error: "Not Found",
      message: "No subtitles found",
    });
  }

  let ratedSubtitles: RatedSubtitle[] = subtitleLinks
    .map((_, el) => {
      const url = `https://yifysubtitles.ch${$(el)
        .find("a")
        .attr("href")
        .replace("subtitles", "subtitle")}.zip`;
      const name = getName($(el).find(".sub-lang").text());
      const code = getCode(name);
      const rating = Number($(el).find(".rating-cell").find("span").text());

      return {
        lang: {
          code,
          name,
        },
        rating,
        url,
      };
    })
    .get();

  if (query.rating) {
    ratedSubtitles = ratedSubtitles.filter(
      (subtitle) => subtitle.rating >= query.rating
    );
  }

  // Sort by rating
  ratedSubtitles = ratedSubtitles.sort((a, b) => b.rating - a.rating);

  // once we have the subtitles, we can remove the rating property
  let subtitles: Subtitle[] = ratedSubtitles.map((subtitle) => {
    const { rating, ...rest } = subtitle;
    return rest;
  });

  // Remove duplicate languages
  let langs = [...new Set(subtitles.map((subtitle) => subtitle.lang.code))];

  if (query.lang) {
    subtitles = subtitles.filter(
      (subtitle) => subtitle.lang.code === query.lang
    );
  }

  // Filters out lower rated subtitles if there are multiple entries for the same language
  subtitles = subtitles.filter((subtitle) => {
    if (langs.includes(subtitle.lang.code)) {
      langs = langs.filter((lang) => lang !== subtitle.lang.code);
      return true;
    }
    return false;
  });

  logger.info(`Found ${subtitles.length} subtitles for ${imdb}`);
  return node.prepareResponse({
    count: subtitles.length,
    subtitles,
  });
});
