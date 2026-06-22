"""AC lead extraction (task 12.3).

Captures a :class:`~agentcore.leads.lead_extractor.Lead` from a non-booking
inquiry that carries contactable information and fans it out to CP-3 via an
injected ``publish_lead`` (Requirements 12.1, 12.2, 12.3).
"""

from agentcore.leads.lead_extractor import (
    ContactInfo,
    Inquiry,
    Lead,
    LeadExtractor,
    LeadPublisher,
    LeadScopeError,
)

__all__ = [
    "ContactInfo",
    "Inquiry",
    "Lead",
    "LeadExtractor",
    "LeadPublisher",
    "LeadScopeError",
]
