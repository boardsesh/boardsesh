export const feedbackTypeDefs = /* GraphQL */ `
  enum AppFeedbackPlatform {
    ios
    android
    web
  }

  enum AppFeedbackSource {
    prompt
    drawer_feedback
    shake_bug
    drawer_bug
  }

  """
  Input for submitAppFeedback mutation.
  """
  input SubmitAppFeedbackInput {
    """
    1–5 star rating. Null for bug reports.
    """
    rating: Int

    """
    Optional free-text comment. Required for bug-report sources; typically
    present for rating sources when rating is below 3.
    """
    comment: String

    platform: AppFeedbackPlatform!

    """
    App build version (native) or deployed web version. Optional.
    """
    appVersion: String

    source: AppFeedbackSource!
  }
`;
