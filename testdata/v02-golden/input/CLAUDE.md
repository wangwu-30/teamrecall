## Gateway retries

Never retry in the service layer; register retries only in the gateway wrapper so callers see one policy.
