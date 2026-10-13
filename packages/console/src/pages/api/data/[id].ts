import { getBaseUrlForApi } from "../../../lib/api";
import { isNonEmptyString } from "../../../utils";

export default async function handler(req, res) {
  try {
    const { access_token, id } = req.query;
    if (!isNonEmptyString(id)) {
      res.status(400).send("must provide a task id");
      return;
    }

    const qs = new URLSearchParams();
    qs.set("id", id);
    if (access_token) {
      qs.set("access_token", access_token);
    }
    const url = `${getBaseUrlForApi()}/data?${qs.toString()}`;
    res.redirect(url);
  } catch (x) {
    res.status(500).send();
  }
};
