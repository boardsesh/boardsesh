// Parameters arrive through runScript.env; these hooks execute on the host.
const response = http.post(PROFILE_MARK_URL, {
  body: JSON.stringify({ token: PROFILE_SESSION_TOKEN, segment: SEGMENT, boundary: BOUNDARY }),
  headers: { 'Content-Type': 'application/json' },
});
if (response.status !== 200) throw new Error('Profiling boundary was not acknowledged');
const acknowledgement = json(response.body);
if (acknowledgement.acknowledged !== true) throw new Error('Native profiling boundary acknowledgement missing');
