import { getBaseUrlForApi } from "../../../lib/api";
import { isNonEmptyString } from "../../../utils";

export default async function handler(req, res) {
  try {
    const { token, id } = req.query;
    if (!isNonEmptyString(id)) {
      res.status(400).send("must provide a task id");
      return;
    }
    const qs = new URLSearchParams();
    qs.set("id", id);
    if (token) {
      qs.set("access_token", token);
    }
    const formUrl = `${getBaseUrlForApi()}/form?${qs.toString()}`;
    res.redirect(formUrl);
  } catch (x) {
    res.status(500).send();
  }
};
